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
import { type Transport, type TransportCapabilities } from "./types.js";
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
export declare class BridgeTransport implements Transport {
    private opts;
    readonly id: string;
    capabilities: TransportCapabilities;
    private running;
    private loop;
    private controller;
    constructor(opts: BridgeOptions);
    private url;
    private headers;
    /** Interroge `/health` : dit si le pont répond et s'il sait faire du vocal. */
    probe(): Promise<{
        ok: boolean;
        voice: boolean;
        detail?: string;
    }>;
    start(handler: (msg: IncomingMessage) => Promise<void>): Promise<void>;
    private pump;
    stop(): Promise<void>;
    sendText(contactId: string, text: string): Promise<void>;
    sendVoice(contactId: string, audio: Buffer, mimeType: string): Promise<void>;
}
