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
export class TransportError extends Error {
}
//# sourceMappingURL=types.js.map