/**
 * Le contrat de transport.
 *
 * Tout le reste de l'extension — contextes, persona, garde-fous, escalade,
 * synthèse vocale — ignore complètement sur quel canal il tourne. Ajouter un
 * canal, c'est écrire ce fichier-là et rien d'autre.
 *
 * Un driver doit respecter quatre règles, faute de quoi les contextes par
 * interlocuteur ne tiennent pas :
 *
 *  1. `contactId` est **stable dans le temps** pour une même personne. C'est la
 *     clé du contexte : s'il change entre deux messages, l'interlocuteur repart
 *     de zéro et le fil est perdu.
 *  2. `contactId` est **unique par personne**. Deux personnes qui partagent un
 *     identifiant verraient leurs conversations fusionner.
 *  3. `start()` ne rend la main que lorsque le canal est réellement prêt à
 *     recevoir, et `handler` est appelé une fois par message entrant, sans
 *     doublon après reprise.
 *  4. `sendVoice()` échoue franchement si le canal ne sait pas envoyer d'audio,
 *     plutôt que d'envoyer silencieusement autre chose. L'appelant sait
 *     retomber sur du texte, mais seulement si on lui dit.
 */
import type { IncomingMessage } from "../types.js";
export interface TransportCapabilities {
    /** Le canal sait envoyer une note vocale. */
    voice: boolean;
    /** Le canal sait afficher un indicateur « en train d'écrire ». */
    typing: boolean;
}
export interface Transport {
    readonly id: string;
    readonly capabilities: TransportCapabilities;
    /** Démarre la réception. Le handler est appelé pour chaque message entrant. */
    start(handler: (msg: IncomingMessage) => Promise<void>): Promise<void>;
    stop(): Promise<void>;
    sendText(contactId: string, text: string): Promise<void>;
    /**
     * Envoie une note vocale. Doit lever si `capabilities.voice` est faux, ou si
     * le format audio n'est pas accepté par le canal.
     */
    sendVoice(contactId: string, audio: Buffer, mimeType: string): Promise<void>;
    /** Optionnel : indicateur de frappe pendant la génération de la réponse. */
    setTyping?(contactId: string, on: boolean): Promise<void>;
}
export declare class TransportError extends Error {
}
