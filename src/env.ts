/**
 * Chargement du fichier `.env` local (extension/.env, ignoré par git).
 *
 * Le projet garde les secrets hors du dépôt : Telegram passe déjà par des
 * variables d'environnement, Snapchat Web les rejoint (SNAPCHAT_EMAIL /
 * SNAPCHAT_PASSWORD). Ce chargeur les lit depuis `.env` au démarrage, sans
 * dépendance externe, et sans jamais écraser une variable déjà posée par
 * l'hôte ou la ligne de commande.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let loaded = false;

/** Ligne reconnue : `CLÉ=valeur`, `export CLÉ=valeur`, guillemets optionnels. */
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/;

/**
 * Analyse le contenu d'un `.env` en paires clé/valeur. Pur : les lignes
 * vides, de commentaire (`#…`) ou malformées sont ignorées, les guillemets
 * simples ou doubles englobants sont retirés, la valeur garde ses `=`.
 */
export function parseDotEnv(raw: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = LINE.exec(line);
    if (!m?.[1] || m[2] == null) continue;
    entries[m[1]] = m[2].replace(/^(['"])([\s\S]*)\1$/, "$2");
  }
  return entries;
}

/**
 * Lit le premier `.env` trouvé (chemin explicite, puis cwd, puis racine du
 * paquet) et injecte les variables manquantes dans `process.env`. Idempotent :
 * les appels suivants ne relisent rien.
 */
export function loadDotEnv(explicitPath?: string): string | null {
  if (loaded) return null;
  loaded = true;

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    explicitPath,
    resolve(process.cwd(), ".env"),
    resolve(moduleDir, "..", ".env"),
  ].filter((p): p is string => Boolean(p));

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const [key, value] of Object.entries(parseDotEnv(raw))) {
      if (process.env[key] == null || process.env[key] === "") {
        process.env[key] = value;
      }
    }
    return path;
  }
  return null;
}
