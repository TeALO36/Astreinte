/**
 * Adaptateur `SnapchatClient` → `Transport`.
 *
 * Le dépôt contient deux piles qui ne se parlaient pas : d'un côté `src/client/*`
 * (adb, web, telegram) qui sait réellement piloter un compte, de l'autre le
 * démon autonome de `src/agent.ts` qui sait tenir un contexte par interlocuteur,
 * appliquer une persona et escalader — mais qui n'atteignait un canal que par un
 * pont HTTP externe. Ce fichier est le chaînon manquant : n'importe quel
 * `SnapchatClient` devient un canal du démon, sans pont ni processus tiers.
 *
 * Deux impédances à absorber :
 *
 *  - **`SnapchatClient` est en pull**, sans flux d'événements. On sonde donc les
 *    conversations et on émet les messages apparus depuis le dernier tour.
 *  - **`sendVoiceNote` attend un chemin de fichier**, alors que `Transport`
 *    fournit un buffer. On matérialise l'audio dans un fichier temporaire, qu'on
 *    supprime ensuite.
 *
 * Le piège numéro un d'un canal en pull est la boucle : réémettre en entrée ce
 * qu'on vient d'envoyer fait que l'assistant se répond à lui-même indéfiniment.
 * Deux garde-fous ici — les identifiants des messages émis sont mémorisés, et
 * l'identifiant du compte est appris au premier envoi puis filtré.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SnapchatClient } from "../client/types.js";
import type { IncomingMessage } from "../types.js";
import { TransportError, type Transport, type TransportCapabilities } from "./types.js";

export interface ClientTransportOptions {
  client: SnapchatClient;
  /** Nom affiché dans les journaux. */
  label?: string;
  /** Le canal sait-il envoyer une note vocale ? */
  voice?: boolean;
  pollIntervalMs?: number;
  /** Conversations relues à chaque tour. */
  conversationLimit?: number;
  /** Messages relus par conversation. */
  messageLimit?: number;
  /**
   * Répondre aux messages déjà présents au démarrage. Faux par défaut : lancer
   * le démon ne doit pas déclencher une salve de réponses sur tout l'historique.
   */
  replayBacklog?: boolean;
  /**
   * Identifiant du compte piloté, si vous le connaissez. Sinon il est appris au
   * premier message envoyé.
   */
  selfId?: string;
}

/** Extension de fichier correspondant au type MIME, pour que le client la reconnaisse. */
function extensionFor(mimeType: string): string {
  const m = mimeType.toLowerCase();
  if (m.includes("ogg") || m.includes("opus")) return ".ogg";
  if (m.includes("mpeg") || m.includes("mp3")) return ".mp3";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return ".m4a";
  return ".wav";
}

const MAX_REMEMBERED_SENT = 500;

export class ClientTransport implements Transport {
  readonly id: string;
  readonly capabilities: TransportCapabilities;

  private running = false;
  private loop: Promise<void> | null = null;
  /** Horodatage du dernier message vu, par conversation. */
  private seen = new Map<string, number>();
  /** Identifiants des messages que nous avons émis. */
  private sent = new Set<string>();
  private selfId?: string;
  private primed = false;

  constructor(private opts: ClientTransportOptions) {
    this.id = opts.label ?? "client";
    this.capabilities = { voice: opts.voice ?? false, typing: false };
    this.selfId = opts.selfId;
  }

  async start(handler: (msg: IncomingMessage) => Promise<void>): Promise<void> {
    // Un premier appel avant de rendre la main : un client mal configuré doit
    // échouer au démarrage, pas silencieusement à chaque tour de boucle.
    try {
      await this.opts.client.getConversations(this.opts.conversationLimit ?? 20);
    } catch (e) {
      throw new TransportError(`canal ${this.id} injoignable : ${(e as Error).message}`);
    }

    this.running = true;
    // Établit la ligne de base sans rien émettre, sauf demande explicite.
    if (!this.opts.replayBacklog) {
      await this.scan(async () => undefined);
    }
    this.primed = true;
    this.loop = this.pump(handler);
    console.error(
      `[snap-astreinte] canal ${this.id} connecté` +
        `${this.capabilities.voice ? ", vocal disponible" : ", vocal indisponible"}`,
    );
  }

  private async pump(handler: (msg: IncomingMessage) => Promise<void>): Promise<void> {
    const interval = Math.max(this.opts.pollIntervalMs ?? 3000, 500);
    while (this.running) {
      try {
        await this.scan(handler);
      } catch (e) {
        console.error(`[snap-astreinte] relève ${this.id} : ${(e as Error).message}`);
      }
      await sleep(interval);
    }
  }

  /** Un tour de relève. `emit` reçoit chaque message entrant retenu. */
  private async scan(emit: (msg: IncomingMessage) => Promise<void>): Promise<void> {
    const conversations = await this.opts.client.getConversations(
      this.opts.conversationLimit ?? 20,
    );

    for (const conv of conversations) {
      const since = this.seen.get(conv.id) ?? 0;
      const activity = Date.parse(conv.lastActivity);
      // Rien de neuf dans cette conversation : on évite un aller-retour.
      if (this.primed && Number.isFinite(activity) && activity <= since) continue;

      let messages;
      try {
        messages = await this.opts.client.getMessages(conv.id, this.opts.messageLimit ?? 20);
      } catch (e) {
        console.error(`[snap-astreinte] lecture de ${conv.id} : ${(e as Error).message}`);
        continue;
      }

      const fresh = messages
        .map((m) => ({ m, at: Date.parse(m.timestamp) }))
        .filter(({ m, at }) => {
          if (!Number.isFinite(at) || at <= since) return false;
          if (this.sent.has(m.id)) return false;
          if (this.selfId && m.senderId === this.selfId) return false;
          return true;
        })
        .sort((a, b) => a.at - b.at);

      // La ligne de base avance même si rien n'est retenu, sinon une
      // conversation bruyante serait relue en entier à chaque tour.
      const newest = messages.reduce((max, m) => {
        const at = Date.parse(m.timestamp);
        return Number.isFinite(at) && at > max ? at : max;
      }, since);
      this.seen.set(conv.id, newest);

      for (const { m, at } of fresh) {
        const isVoice = m.type === "audio";
        const text = m.text ?? "";
        if (!text && !isVoice) continue;
        await emit({
          contactId: conv.id,
          contactName: conv.displayName,
          text,
          isVoice,
          receivedAt: at,
        });
      }

      if (fresh.length) {
        await this.opts.client.markAsRead(conv.id).catch(() => undefined);
      }
    }
  }

  private remember(id: string, senderId?: string): void {
    this.sent.add(id);
    // Le compte se révèle au premier envoi : tout ce qu'il émettra ensuite,
    // y compris depuis le téléphone, cessera d'être pris pour une demande.
    if (!this.selfId && senderId) this.selfId = senderId;
    if (this.sent.size > MAX_REMEMBERED_SENT) {
      const excess = this.sent.size - MAX_REMEMBERED_SENT;
      let dropped = 0;
      for (const old of this.sent) {
        this.sent.delete(old);
        if (++dropped >= excess) break;
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop?.catch(() => undefined);
    this.loop = null;
  }

  async sendText(contactId: string, text: string): Promise<void> {
    const sent = await this.opts.client.sendMessage({ conversationId: contactId, text });
    this.remember(sent.id, sent.senderId);
  }

  async sendVoice(contactId: string, audio: Buffer, mimeType: string): Promise<void> {
    if (!this.capabilities.voice) {
      throw new TransportError(`le canal ${this.id} ne sait pas envoyer de note vocale`);
    }
    const dir = mkdtempSync(join(tmpdir(), "snap-astreinte-voice-"));
    const path = join(dir, `note${extensionFor(mimeType)}`);
    try {
      writeFileSync(path, audio);
      const sent = await this.opts.client.sendVoiceNote({
        conversationId: contactId,
        audioPath: path,
      });
      this.remember(sent.id, sent.senderId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
