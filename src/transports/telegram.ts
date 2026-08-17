/**
 * Driver Telegram — compte personnel via MTProto (GramJS).
 *
 * Pas d'API officielle, pas de jeton de bot : on se connecte avec le compte
 * Telegram de l'exploitant (api_id/api_hash créés sur my.telegram.org, session
 * obtenue une fois par `npm run telegram:login`). Le compte apparaît comme un
 * compte utilisateur normal, jamais avec le badge « bot », et rien ne transite
 * par un intermédiaire.
 *
 * La réception est en push (`addEventHandler` + filtre `NewMessage`) : aucune
 * adresse publique à exposer, aucun webhook, aucun polling. Au démarrage, on
 * rattrape les conversations non lues reçues pendant l'arrêt (l'ancien driver
 * les rejouait via getUpdates), puis on marque ces conversations comme lues
 * pour ne pas répondre deux fois au même message. Un ensemble de messages déjà
 * vus partage le handler temps réel et le rattrapage : un message arrivé
 * pendant le rattrapage n'est pas traité deux fois.
 *
 * `sendVoice` demande de l'OGG/Opus pour une vraie note vocale avec sa forme
 * d'onde ; on convertit via ffmpeg quand il est là, et on le dit clairement
 * quand il ne l'est pas.
 *
 * L'import se fait depuis le chemin de fichier `telegram/events/NewMessage.js`
 * : le sous-chemin `telegram/events` n'est pas résolu sous
 * `moduleResolution: Node16`. Les champs du message restent typés en local
 * (même style que `client/telegram-client.ts`), sans dépendre de la structure
 * interne du paquet.
 */

import { TelegramClient, Api, sessions } from "telegram";
import { NewMessage, type NewMessageEvent } from "telegram/events/NewMessage.js";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "../types.js";
import {
  ensureSessionAuthorized,
  loadSessionString,
  resolveTelegramSession,
  type ResolvedTelegramSession,
  type TelegramSessionConfig,
} from "../telegram/session.js";
import { TransportError, type Transport, type TransportCapabilities } from "./types.js";

const { StringSession } = sessions;

type EntityLike = NonNullable<Parameters<TelegramClient["getMessages"]>[0]>;

type TelegramSender = {
  firstName?: string;
  lastName?: string;
  username?: string;
  title?: string;
};

type TelegramMessage = {
  id?: { toString(): string } | string | number;
  out?: boolean;
  message?: string;
  date?: number;
  chatId?: { toString(): string } | string | number;
  peerId?: { toString(): string } | string | number;
  voice?: unknown;
  editDate?: unknown;
  getSender?(): Promise<TelegramSender | undefined>;
};

export class TelegramTransport implements Transport {
  readonly id = "telegram";
  readonly capabilities: TransportCapabilities = { voice: true, images: true, typing: true };

  private readonly session: ResolvedTelegramSession;
  private client: TelegramClient | null = null;
  private handler: ((msg: IncomingMessage) => Promise<void>) | null = null;
  private running = false;
  private eventHandler: ((event: NewMessageEvent) => void) | null = null;
  private readonly messageFilter = new NewMessage({});
  private readonly seen = new Set<string>();

  constructor(config: TelegramSessionConfig = {}) {
    this.session = resolveTelegramSession(config);
  }

  private async ensureClient(): Promise<TelegramClient> {
    if (this.client) return this.client;

    // En mode bot, aucun fichier de session n'est requis : le jeton suffit et
    // ensureSessionAuthorized crée l'authentification au premier démarrage.
    let sessionString = "";
    try {
      sessionString = loadSessionString(this.session);
    } catch (e) {
      if (this.session.authType !== "bot" || !this.session.botToken) throw e;
    }

    const client = new TelegramClient(
      new StringSession(sessionString),
      this.session.apiId,
      this.session.apiHash,
      { connectionRetries: 5 },
    );
    await ensureSessionAuthorized(client, this.session);
    this.client = client;
    return client;
  }

  async whoami(): Promise<string> {
    const client = await this.ensureClient();
    const me = (await client.getMe()) as { username?: string };
    return me.username ? `@${me.username}` : "compte personnel";
  }

  async start(handler: (msg: IncomingMessage) => Promise<void>): Promise<void> {
    const client = await this.ensureClient();
    const who = await this.whoami();
    console.error(`[snap-astreinte] Telegram connecté : ${who}`);

    this.handler = handler;
    this.running = true;
    this.eventHandler = (event) => {
      void this.onEvent(event);
    };
    // Le filtre NewMessage normalise toutes les formes d'update (message court,
    // message de canal, etc.) en un objet message complet.
    client.addEventHandler(this.eventHandler, this.messageFilter);

    // Rattrape les non-lus reçus pendant que le démon était arrêté. La
    // déduplication par id partagée avec le handler temps réel évite de
    // répondre deux fois à un message arrivé pendant le rattrapage.
    await this.catchUpUnread(client);
  }

  private async onEvent(event: NewMessageEvent): Promise<void> {
    if (!this.running || !this.handler) return;
    const message = event.message as TelegramMessage;
    if (!message || message.out) return; // nos propres envois ne sont pas des entrées
    // Un message édité (UpdateEditMessage) n'est pas produit par ce filtre,
    // mais on garde la garde par précaution.
    if (message.editDate) return;

    const text = message.message ?? "";
    const isVoice = !!message.voice;

    // Un vocal sans transcription n'a pas de texte exploitable : on le signale
    // plutôt que de laisser le modèle répondre à du vide.
    if (!text && !isVoice) return;

    const contactId = String(message.chatId ?? message.peerId ?? "");
    if (!contactId) return;

    await this.dispatch(message, contactId, text, isVoice);
  }

  private async dispatch(
    message: TelegramMessage,
    contactId: string,
    text: string,
    isVoice: boolean,
  ): Promise<void> {
    if (!this.handler) return;

    // Déduplication : un id de message vu une fois ne repasse jamais, qu'il
    // vienne du rattrapage ou du handler temps réel.
    const key = `${contactId}:${String(message.id ?? "")}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    // Borne l'ensemble pour ne pas grossir sans fin sur une longue session.
    if (this.seen.size > 10000) this.seen.clear();

    let contactName: string | undefined;
    try {
      const sender = await message.getSender?.();
      if (sender) {
        contactName = sender.firstName ?? sender.title ?? sender.username ?? undefined;
      }
    } catch {
      // Le nom est cosmétique : un échec ne doit pas faire tomber le message.
    }

    try {
      await this.handler({
        contactId,
        contactName,
        text,
        isVoice,
        receivedAt: (message.date ?? 0) * 1000,
      });
    } catch (e) {
      console.error(`[snap-astreinte] traitement du message échoué : ${(e as Error).message}`);
    }
  }

  /**
   * Rejoue les messages non lus des conversations, une fois au démarrage,
   * puis marque ces conversations comme lues pour éviter de les re-traiter au
   * prochain démarrage. Borné : 20 conversations, 5 messages chacune.
   */
  private async catchUpUnread(client: TelegramClient): Promise<void> {
    if (!this.handler) return;
    try {
      let dialogs = 0;
      for await (const dialog of client.iterDialogs({ limit: 200 })) {
        const item = dialog as {
          unreadCount?: number;
          entity?: unknown;
        };
        if (!item.unreadCount || item.unreadCount <= 0 || !item.entity) continue;
        if (dialogs >= 20) break;
        dialogs++;

        const entity = item.entity as EntityLike;
        const messages = (await client.getMessages(entity, {
          limit: Math.min(item.unreadCount, 5),
        })) as unknown[];

        // getMessages renvoie du plus récent au plus ancien : on traite dans
        // l'ordre chronologique pour respecter le fil de conversation.
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i] as TelegramMessage;
          if (!message || message.out) continue;
          const text = message.message ?? "";
          const isVoice = !!message.voice;
          if (!text && !isVoice) continue;
          const contactId = String(message.chatId ?? message.peerId ?? "");
          if (!contactId) continue;
          await this.dispatch(message, contactId, text, isVoice);
        }

        // Marque lu après traitement : sans ça, le prochain démarrage
        // répondrait une deuxième fois au même message.
        await client.markAsRead(entity).catch((e) => {
          console.warn(
            `[snap-astreinte] échec markAsRead (${(e as Error).message}) : les non-lus ` +
              `seront re-répondus au prochain démarrage.`,
          );
        });
      }
    } catch (e) {
      console.error(`[snap-astreinte] rattrapage des non-lus : ${(e as Error).message}`);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.client && this.eventHandler) {
      try {
        this.client.removeEventHandler(this.eventHandler, this.messageFilter);
      } catch {
        // Le client peut déjà être fermé ; l'important est d'arrêter.
      }
    }
    this.eventHandler = null;
    this.handler = null;
    await this.client?.disconnect().catch(() => undefined);
    this.client = null;
  }

  async sendText(contactId: string, text: string): Promise<void> {
    const client = await this.ensureClient();
    // Telegram refuse au-delà de 4096 caractères : on découpe plutôt que de
    // laisser l'API rejeter tout le message.
    for (const chunk of chunkText(text, 4000)) {
      await client.sendMessage(contactId, { message: chunk });
    }
  }

  async sendVoice(contactId: string, audio: Buffer, mimeType: string): Promise<void> {
    const client = await this.ensureClient();
    let payload = audio;

    if (!mimeType.includes("ogg") && !mimeType.includes("opus")) {
      const converted = await toOpus(audio).catch(() => null);
      if (!converted) {
        throw new TransportError(
          "Telegram attend de l'OGG/Opus pour une note vocale, et ffmpeg est introuvable pour convertir. " +
            "Installez ffmpeg, ou configurez un moteur TTS qui produit directement de l'OGG.",
        );
      }
      payload = converted;
    }

    await client.sendFile(contactId, { file: payload, voiceNote: true });
  }

  async sendImage(
    contactId: string,
    media: Buffer | string,
    mimeType: string,
    caption?: string,
  ): Promise<void> {
    const client = await this.ensureClient();

    // Un buffer nu n'a pas d'extension : Telegram décide photo/fichier au nom.
    // On le matérialise dans un fichier temporaire nommé d'après son type pour
    // qu'il parte bien en photo, puis on supprime le fichier.
    if (Buffer.isBuffer(media)) {
      const dir = mkdtempSync(join(tmpdir(), "snap-astreinte-image-"));
      const extension = extensionForImage(mimeType);
      const path = join(dir, `image${extension}`);
      try {
        writeFileSync(path, media);
        await client.sendFile(contactId, {
          file: path,
          caption: caption ?? "",
          forceDocument: false,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      return;
    }

    await client.sendFile(contactId, {
      file: media,
      caption: caption ?? "",
      forceDocument: false,
    });
  }

  async setTyping(contactId: string, on: boolean): Promise<void> {
    if (!on) return;
    const client = await this.ensureClient();
    await client
      .invoke(
        new Api.messages.SetTyping({
          peer: contactId,
          action: new Api.SendMessageRecordAudioAction(),
        }),
      )
      .catch(() => undefined);
  }
}

/** Extension de fichier selon le type MIME, pour l'envoi d'une image. */
function extensionForImage(mimeType: string): string {
  const m = mimeType.toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
  if (m.includes("webp")) return ".webp";
  if (m.includes("gif")) return ".gif";
  if (m.includes("bmp")) return ".bmp";
  return ".png";
}

/** Convertit vers OGG/Opus via ffmpeg. Rejette si ffmpeg est absent. */
function toOpus(input: Buffer): Promise<Buffer> {
  return new Promise((resolveDone, rejectDone) => {
    const child = spawn(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-c:a", "libopus", "-b:a", "32k", "-f", "ogg", "pipe:1"],
      { windowsHide: true },
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.on("error", rejectDone);
    child.on("close", (code) => {
      if (code === 0 && chunks.length) resolveDone(Buffer.concat(chunks));
      else rejectDone(new Error(`ffmpeg code ${code}`));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

export function chunkText(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const window = rest.slice(0, size);
    // Coupe sur un saut de ligne ou une fin de phrase quand c'est possible,
    // pour ne pas trancher un mot en deux entre deux messages.
    const at = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(". "));
    const cut = at > size * 0.5 ? at + 1 : size;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}
