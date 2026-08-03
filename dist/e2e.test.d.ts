/**
 * Test de bout en bout : un message entre par le pont, une réponse en sort.
 *
 * Rien n'est simulé côté extension — c'est le vrai `Agent`, le vrai
 * `BridgeTransport`, la vraie configuration. Seuls le canal et le modèle sont
 * remplacés par des serveurs HTTP locaux, exactement comme le seraient un pont
 * Snapchat et un llama-server.
 *
 *   node --test dist/e2e.test.js
 */
export {};
