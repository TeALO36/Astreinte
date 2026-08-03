/**
 * Driver Telegram.
 *
 * Long polling plutôt que webhook : aucune adresse publique à exposer, aucun
 * certificat, l'extension tourne derrière n'importe quelle box. `getUpdates`
 * bloque côté serveur jusqu'à 25 s, donc la latence reste faible sans marteler
 * l'API.
 *
 * `sendVoice` demande de l'OGG/Opus pour afficher une vraie note vocale avec sa
 * forme d'onde ; un WAV passerait en pièce jointe. On convertit via ffmpeg
 * quand il est là, et on le dit clairement quand il ne l'est pas.
 */
import type { IncomingMessage } from "../types.js";
import { type Transport, type TransportCapabilities } from "./types.js";
export declare class TelegramTransport implements Transport {
    private token;
    private pollIntervalMs;
    readonly id = "telegram";
    readonly capabilities: TransportCapabilities;
    private offset;
    private running;
    private loop;
    constructor(token: string, pollIntervalMs?: number);
    private url;
    private call;
    /** Vérifie le jeton au démarrage : un jeton faux doit se voir tout de suite. */
    whoami(): Promise<string>;
    start(handler: (msg: IncomingMessage) => Promise<void>): Promise<void>;
    private pump;
    stop(): Promise<void>;
    sendText(contactId: string, text: string): Promise<void>;
    sendVoice(contactId: string, audio: Buffer, mimeType: string): Promise<void>;
    setTyping(contactId: string, on: boolean): Promise<void>;
}
export declare function chunkText(text: string, size: number): string[];
