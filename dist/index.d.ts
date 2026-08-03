#!/usr/bin/env node
/**
 * Point d'entrée. Deux modes :
 *
 *   snap-astreinte daemon   la permanence elle-même : reçoit, répond, envoie
 *   snap-astreinte mcp      serveur MCP de supervision, sur stdio
 *   snap-astreinte check    vérifie la configuration sans rien envoyer
 *
 * Les deux premiers peuvent tourner en même temps : ils partagent les fichiers
 * de contexte et de configuration.
 */
export {};
