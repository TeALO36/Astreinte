/**
 * Canal Snapchat.
 *
 * Snapchat n'expose aucune API permettant de lire ou d'envoyer des messages :
 * ni Login Kit, ni Camera Kit, ni Creative Kit ne donnent accès aux
 * conversations. Le seul moyen d'y parvenir passe par un client non officiel ou
 * du pilotage d'interface sur émulateur, avec le contournement de l'attestation
 * d'intégrité que cela implique. Cette partie-là n'est pas fournie ici.
 *
 * Ce que fournit ce fichier, en revanche, c'est **tout le reste** : le canal
 * Snapchat est un `BridgeTransport` préconfiguré. Vous branchez votre propre
 * pont sur le contrat documenté dans `bridge.ts`, et l'extension lui parle
 * comme à n'importe quel autre canal — contextes isolés par interlocuteur,
 * persona, garde-fous, escalade et notes vocales fonctionnent à l'identique,
 * sans une ligne à changer ailleurs.
 *
 * ## Ce que votre pont doit faire
 *
 * Quatre méthodes, rien de plus :
 *
 * | Route             | Rôle                                                     |
 * |-------------------|----------------------------------------------------------|
 * | `GET /health`     | dire s'il est prêt, et s'il sait envoyer du vocal          |
 * | `GET /events`     | émettre en SSE chaque message reçu                         |
 * | `POST /send`      | envoyer un texte à un `contactId`                          |
 * | `POST /sendVoice` | envoyer une note vocale (OGG/Opus ou WAV selon le pont)     |
 *
 * Le point délicat côté pont est l'identifiant : `contactId` doit rester le
 * même pour une personne d'une session à l'autre. Un identifiant dérivé du nom
 * d'affichage change dès que la personne renomme son profil, et le fil de
 * conversation repart alors de zéro.
 *
 * L'autre point délicat est l'anti-boucle : le pont ne doit jamais réémettre en
 * entrée les messages qu'il vient lui-même d'envoyer, sans quoi l'assistant se
 * répond à lui-même indéfiniment.
 */
import { BridgeTransport } from "./bridge.js";
import { TransportError } from "./types.js";
export const SNAPCHAT_BRIDGE_DEFAULT_URL = "http://127.0.0.1:8765";
export function createSnapchatTransport(opts) {
    const baseUrl = (opts.baseUrl ?? "").trim() || SNAPCHAT_BRIDGE_DEFAULT_URL;
    if (!opts.baseUrl?.trim()) {
        console.error(`[snap-astreinte] aucune adresse de pont Snapchat configurée, essai sur ${SNAPCHAT_BRIDGE_DEFAULT_URL}`);
    }
    return new BridgeTransport({ ...opts, baseUrl, label: "snapchat" });
}
/** Message d'aide affiché quand le pont est absent, plutôt qu'une pile d'appels. */
export function snapchatSetupHint(baseUrl) {
    return [
        `Le pont Snapchat n'a pas répondu sur ${baseUrl}.`,
        "",
        "Ce canal attend un processus local qui expose quatre routes :",
        "  GET  /health     → { ok: true, voice: true }",
        "  GET  /events     → flux SSE des messages reçus",
        "  POST /send       → { contactId, text }",
        "  POST /sendVoice  → { contactId, audioBase64, mimeType }",
        "",
        "Le contrat complet est documenté en tête de src/transports/bridge.ts.",
        "Démarrez le pont, puis relancez l'extension.",
    ].join("\n");
}
export { TransportError };
//# sourceMappingURL=snapchat.js.map