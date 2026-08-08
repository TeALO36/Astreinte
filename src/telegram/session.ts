/**
 * Session Telegram partagée entre le driver de conversation et les alertes.
 *
 * Un seul compte, le vôtre : api_id/api_hash créés sur my.telegram.org, session
 * obtenue une fois par `npm run telegram:login`. Aucun jeton de bot, aucune API
 * officielle : le compte apparaît comme un compte utilisateur normal, jamais
 * avec le badge « bot ».
 */

import { existsSync, readFileSync } from "node:fs";

export const DEFAULT_SESSION_FILE = ".telegram/session.txt";

export interface TelegramSessionConfig {
  apiId?: number | string;
  apiHash?: string;
  sessionString?: string;
  sessionFile?: string;
}

export interface ResolvedTelegramSession {
  apiId: number;
  apiHash: string;
  sessionString?: string;
  sessionFile: string;
}

/**
 * Résout les identifiants depuis la config, puis l'environnement. Les mêmes
 * variables servent au script de login : TELEGRAM_* en CLI, SNAP_ASTREINTE_*
 * quand l'hôte injecte les secrets.
 */
export function resolveTelegramSession(
  config: TelegramSessionConfig = {},
): ResolvedTelegramSession {
  const apiId = config.apiId
    ? Number(config.apiId)
    : Number(process.env.TELEGRAM_API_ID ?? process.env.SNAP_ASTREINTE_TELEGRAM_API_ID ?? "");
  const apiHash =
    config.apiHash ||
    process.env.TELEGRAM_API_HASH ||
    process.env.SNAP_ASTREINTE_TELEGRAM_API_HASH;

  if (!Number.isInteger(apiId) || apiId <= 0) {
    throw new Error(
      "TELEGRAM_API_ID est requis pour un compte Telegram personnel. " +
        "Créez api_id/api_hash sur https://my.telegram.org.",
    );
  }
  if (!apiHash) {
    throw new Error(
      "TELEGRAM_API_HASH est requis pour un compte Telegram personnel. " +
        "Créez api_id/api_hash sur https://my.telegram.org.",
    );
  }

  const sessionString =
    config.sessionString || process.env.TELEGRAM_SESSION_STRING;
  const sessionFile =
    config.sessionFile ||
    process.env.TELEGRAM_SESSION_FILE ||
    process.env.SNAP_ASTREINTE_TELEGRAM_SESSION_FILE ||
    DEFAULT_SESSION_FILE;

  return { apiId, apiHash, sessionString, sessionFile };
}

/** Lit la session depuis la chaîne ou le fichier. Lève si absente. */
export function loadSessionString(session: ResolvedTelegramSession): string {
  if (session.sessionString) return session.sessionString.trim();
  if (existsSync(session.sessionFile)) {
    return readFileSync(session.sessionFile, "utf8").trim();
  }
  throw new Error(
    "Aucune session Telegram. Lancez « npm run telegram:login » une fois, puis " +
      `redémarrez. La session est stockée dans ${session.sessionFile} et ne doit ` +
      "jamais être commitée.",
  );
}
