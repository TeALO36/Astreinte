/**
 * Driver « bridge » : un canal piloté par un processus externe.
 *
 * C'est la voie pour tout canal qui n'a pas d'API officielle utilisable depuis
 * Node. Vous écrivez (ou lancez) un pont dans le langage de votre choix, il
 * expose le petit contrat HTTP ci-dessous en local, et l'extension s'y branche.
 * Contextes, persona, garde-fous et notes vocales fonctionnent alors
 * exactement comme sur n'importe quel autre canal.
 *
 * ## Contrat attendu du pont
 *
 * ### `GET /events` — flux des messages entrants (Server-Sent Events)
 *
 * Une ligne `data:` par message, en JSON :
 *
 * ```json
 * { "contactId": "u_8f21", "contactName": "Marc", "text": "mon wifi coupe", "isVoice": false, "receivedAt": 1754131200000 }
 * ```
 *
 * `contactId` doit être **stable et unique par personne** : c'est la clé du
 * contexte. S'il change entre deux messages, l'interlocuteur repart de zéro.
 * `receivedAt` est optionnel (millisecondes epoch, l'heure de réception à
 * défaut). Un commentaire SSE (`: ping`) toutes les 15 s garde la connexion en
 * vie et permet de détecter une coupure.
 *
 * ### `POST /send` — envoyer du texte
 *
 * ```json
 * { "contactId": "u_8f21", "text": "Redémarre la box 30 secondes." }
 * ```
 *
 * ### `POST /sendVoice` — envoyer une note vocale
 *
 * ```json
 * { "contactId": "u_8f21", "audioBase64": "...", "mimeType": "audio/ogg" }
 * ```
 *
 * Répondre 4xx/5xx avec `{"error":"..."}` si le canal ne sait pas envoyer
 * d'audio. L'extension retombe alors sur du texte — mais seulement si le pont
 * le dit franchement plutôt que d'envoyer autre chose en silence.
 *
 * ### `GET /health` — état du pont
 *
 * ```json
 * { "ok": true, "voice": true, "detail": "session active" }
 * ```
 *
 * `voice` annonce si `/sendVoice` est utilisable. L'extension le lit au
 * démarrage et n'essaiera pas de synthétiser pour rien.
 *
 * ## Ce que le pont doit garantir
 *
 * Ne pas rejouer un message déjà émis après une reprise de connexion, et ne pas
 * émettre les messages que le pont a lui-même envoyés — sinon l'assistant se
 * répond à lui-même en boucle.
 */

import type { IncomingMessage } from "../types.js";
import { TransportError, type Transport, type TransportCapabilities } from "./types.js";

export interface BridgeOptions {
  /** Racine du pont, par exemple `http://127.0.0.1:8765`. */
  baseUrl: string;
  /** Jeton envoyé en `Authorization: Bearer` si le pont en exige un. */
  token?: string;
  /** Nom affiché dans les journaux. */
  label?: string;
  /** Délai avant reconnexion au flux d'événements, en millisecondes. */
  reconnectMs?: number;
}

export class BridgeTransport implements Transport {
  readonly id: string;
  capabilities: TransportCapabilities = { voice: false, typing: false };

  private running = false;
  private loop: Promise<void> | null = null;
  private controller: AbortController | null = null;

  constructor(private opts: BridgeOptions) {
    this.id = opts.label ?? "bridge";
    if (!opts.baseUrl.trim()) {
      throw new TransportError(
        "adresse du pont absente. Renseignez l'URL locale exposée par votre pont dans la configuration de l'extension.",
      );
    }
  }

  private url(path: string): string {
    return `${this.opts.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.opts.token ? { ...extra, Authorization: `Bearer ${this.opts.token}` } : extra;
  }

  /** Interroge `/health` : dit si le pont répond et s'il sait faire du vocal. */
  async probe(): Promise<{ ok: boolean; voice: boolean; detail?: string }> {
    try {
      const res = await fetch(this.url("/health"), { headers: this.headers() });
      if (!res.ok) return { ok: false, voice: false, detail: `HTTP ${res.status}` };
      const body = (await res.json()) as { ok?: boolean; voice?: boolean; detail?: string };
      return { ok: body.ok !== false, voice: body.voice === true, detail: body.detail };
    } catch (e) {
      return { ok: false, voice: false, detail: (e as Error).message };
    }
  }

  async start(handler: (msg: IncomingMessage) => Promise<void>): Promise<void> {
    const health = await this.probe();
    if (!health.ok) {
      throw new TransportError(
        `le pont ${this.opts.baseUrl} ne répond pas (${health.detail ?? "injoignable"}). ` +
          `Démarrez-le avant l'extension.`,
      );
    }
    this.capabilities = { voice: health.voice, typing: false };
    this.running = true;

    // Le contrat dit que `start()` ne rend la main qu'une fois le canal prêt à
    // recevoir. Sans cette attente, un message émis juste après le démarrage
    // arrive avant que le flux soit ouvert, et il est perdu sans trace.
    let signalReady!: () => void;
    const ready = new Promise<void>((res) => {
      signalReady = res;
    });

    this.loop = this.pump(handler, signalReady);

    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error("le flux /events ne s'est pas ouvert")), 10_000).unref?.(),
    );
    try {
      await Promise.race([ready, timeout]);
    } catch (e) {
      this.running = false;
      this.controller?.abort();
      throw new TransportError(`${this.opts.baseUrl} : ${(e as Error).message}`);
    }

    console.error(
      `[snap-astreinte] pont ${this.id} connecté (${this.opts.baseUrl})` +
        `${health.voice ? ", vocal disponible" : ", vocal indisponible"}` +
        `${health.detail ? ` — ${health.detail}` : ""}`,
    );
  }

  private async pump(
    handler: (msg: IncomingMessage) => Promise<void>,
    onReady?: () => void,
  ): Promise<void> {
    const reconnect = this.opts.reconnectMs ?? 3000;

    while (this.running) {
      this.controller = new AbortController();
      try {
        const res = await fetch(this.url("/events"), {
          headers: this.headers({ Accept: "text/event-stream" }),
          signal: this.controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

        // Le flux est ouvert : le démarrage peut rendre la main.
        onReady?.();
        onReady = undefined;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (this.running) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Les événements SSE sont séparés par une ligne vide.
          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const payload = block
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trim())
              .join("");
            if (!payload) continue;

            let parsed: Partial<IncomingMessage>;
            try {
              parsed = JSON.parse(payload) as Partial<IncomingMessage>;
            } catch {
              console.error(`[snap-astreinte] événement illisible du pont : ${payload.slice(0, 120)}`);
              continue;
            }
            if (!parsed.contactId) {
              console.error("[snap-astreinte] événement sans contactId ignoré");
              continue;
            }
            const text = parsed.text ?? "";
            if (!text && !parsed.isVoice) continue;

            try {
              await handler({
                contactId: String(parsed.contactId),
                contactName: parsed.contactName,
                text,
                isVoice: parsed.isVoice === true,
                receivedAt: parsed.receivedAt ?? Date.now(),
              });
            } catch (e) {
              console.error(`[snap-astreinte] traitement du message échoué : ${(e as Error).message}`);
            }
          }
        }
      } catch (e) {
        if (this.running) {
          console.error(`[snap-astreinte] flux du pont interrompu : ${(e as Error).message}`);
          await sleep(reconnect);
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.controller?.abort();
    await this.loop?.catch(() => undefined);
    this.loop = null;
  }

  async sendText(contactId: string, text: string): Promise<void> {
    const res = await fetch(this.url("/send"), {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ contactId, text }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new TransportError(`pont /send : ${res.status} ${detail.slice(0, 200)}`);
    }
  }

  async sendVoice(contactId: string, audio: Buffer, mimeType: string): Promise<void> {
    if (!this.capabilities.voice) {
      throw new TransportError("ce pont annonce ne pas savoir envoyer de note vocale");
    }
    const res = await fetch(this.url("/sendVoice"), {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ contactId, audioBase64: audio.toString("base64"), mimeType }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new TransportError(`pont /sendVoice : ${res.status} ${detail.slice(0, 200)}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
