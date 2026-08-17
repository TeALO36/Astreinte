/**
 * Session Telegram partagée entre le driver de conversation et les alertes.
 *
 * Deux façons de se connecter, aucune ne coûte rien :
 *
 *  - **Compte personnel** (défaut) : api_id/api_hash créés sur my.telegram.org,
 *    session obtenue une fois par `npm run telegram:login` (téléphone ou QR).
 *    Le compte apparaît comme un compte utilisateur normal, jamais avec le
 *    badge « bot ».
 *  - **Bot** : un jeton de bot suffit, aucun fichier de session à produire.
 *    À la première utilisation, le client s'authentifie avec le jeton et
 *    enregistre la session obtenue — l'utilisateur n'a rien à faire de plus.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { astreinteHome } from "../config.js";

export const DEFAULT_SESSION_FILE = ".telegram/session.txt";

/**
 * Emplacement réel du fichier de session.
 *
 * Un chemin relatif est résolu contre la racine de données de l'extension
 * (`$SNAP_ASTREINTE_HOME`), pas contre le répertoire courant : le processus
 * MCP lancé par Locaryn n'a pas le même répertoire courant que la CLI, et les
 * deux doivent lire et écrire la MÊME session. Un chemin absolu passe tel quel.
 */
export function effectiveSessionFile(sessionFile?: string): string {
  const p = sessionFile?.trim() || DEFAULT_SESSION_FILE;
  return isAbsolute(p) ? p : join(astreinteHome(), p);
}

export type TelegramAuthType = "account" | "bot";

export interface TelegramSessionConfig {
  apiId?: number | string;
  apiHash?: string;
  sessionString?: string;
  sessionFile?: string;
  /** "account" (compte personnel) ou "bot" (jeton). Défaut : account. */
  authType?: TelegramAuthType;
  /** Jeton de bot, utilisé en mode « bot » quand aucune session n'existe. */
  botToken?: string;
}

export interface ResolvedTelegramSession extends TelegramSessionConfig {
  apiId: number;
  apiHash: string;
  sessionFile: string;
  authType: TelegramAuthType;
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
      "TELEGRAM_API_ID est requis pour Telegram. " +
        "Créez api_id/api_hash sur https://my.telegram.org.",
    );
  }
  if (!apiHash) {
    throw new Error(
      "TELEGRAM_API_HASH est requis pour Telegram. " +
        "Créez api_id/api_hash sur https://my.telegram.org.",
    );
  }

  const authType: TelegramAuthType =
    config.authType === "bot" ||
    process.env.TELEGRAM_AUTH_TYPE === "bot" ||
    process.env.SNAP_ASTREINTE_TELEGRAM_AUTH_TYPE === "bot"
      ? "bot"
      : "account";
  const botToken =
    config.botToken ||
    process.env.TELEGRAM_BOT_TOKEN ||
    process.env.SNAP_ASTREINTE_TELEGRAM_BOT_TOKEN;

  const sessionString =
    config.sessionString || process.env.TELEGRAM_SESSION_STRING;
  const sessionFile =
    config.sessionFile ||
    process.env.TELEGRAM_SESSION_FILE ||
    process.env.SNAP_ASTREINTE_TELEGRAM_SESSION_FILE ||
    DEFAULT_SESSION_FILE;

  return { apiId, apiHash, sessionString, sessionFile, authType, botToken };
}

/** Lit la session depuis la chaîne ou le fichier. Lève si absente. */
export function loadSessionString(session: ResolvedTelegramSession): string {
  if (session.sessionString) return session.sessionString.trim();
  const file = effectiveSessionFile(session.sessionFile);
  if (existsSync(file)) {
    return readFileSync(file, "utf8").trim();
  }
  throw new Error(
    "Aucune session Telegram. Lancez « npm run telegram:login » une fois, ou " +
      "passez en mode bot avec un jeton. La session est stockée dans " +
      `${file} et ne doit jamais être commitée.`,
  );
}

/** Écrit la session sur le disque, hors de portée des autres utilisateurs. */
export function saveSessionString(sessionFile: string, session: string): void {
  mkdirSync(dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, session.trim(), { mode: 0o600 });
}

type AuthorizedClient = {
  connect(): Promise<unknown>;
  checkAuthorization(): Promise<boolean>;
  signInBot(
    apiCredentials: { apiId: number; apiHash: string },
    authParams: { botAuthToken: string | (() => string) },
  ): Promise<unknown>;
  getMe(): Promise<unknown>;
  session: { save(): unknown };
};

/**
 * Vérifie la session et, en mode bot, s'authentifie automatiquement quand
 * aucun fichier de session n'existe : l'utilisateur n'a qu'à coller son jeton
 * dans la configuration, rien d'autre.
 */
export async function ensureSessionAuthorized(
  client: AuthorizedClient,
  session: ResolvedTelegramSession,
): Promise<void> {
  await client.connect();
  if (await client.checkAuthorization()) return;

  if (session.authType === "bot" && session.botToken) {
    await client.signInBot(
      { apiId: session.apiId, apiHash: session.apiHash },
      { botAuthToken: session.botToken },
    );
    const me = (await client.getMe()) as { username?: string; id?: unknown } | undefined;
    const sessionString = String(client.session?.save?.() ?? "");
    if (sessionString) {
      saveSessionString(effectiveSessionFile(session.sessionFile), sessionString);
      console.error(
        `[snap-astreinte] session bot enregistrée (${me?.username ? `@${me.username}` : "bot"}) dans ${effectiveSessionFile(session.sessionFile)}`,
      );
    }
    return;
  }

  throw new Error(
    "Session Telegram non autorisée. Lancez « npm run telegram:login » (ou " +
      "« npm run telegram:login:qr ») pour un compte personnel, ou renseignez " +
      "un jeton de bot dans la configuration pour vous connecter en bot.",
  );
}
