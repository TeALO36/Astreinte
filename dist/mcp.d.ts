/**
 * Serveur MCP : la face « supervision » de l'extension.
 *
 * Le démon répond tout seul ; ce serveur-là existe pour que vous puissiez
 * regarder ce qu'il fait et reprendre la main depuis Lochor, Claude Code ou
 * Gemini CLI, sans arrêter quoi que ce soit. Il lit et écrit les mêmes fichiers
 * que le démon, donc les deux peuvent tourner en même temps.
 *
 * Les outils sont volontairement peu nombreux : lister les conversations, en
 * lire une, reprendre la main sur une escalade, oublier un contact, consulter
 * et modifier la configuration.
 */
export declare function runMcpServer(): Promise<void>;
