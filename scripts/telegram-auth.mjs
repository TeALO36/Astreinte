#!/usr/bin/env node
/**
 * Connexion Telegram — fonctions partagées entre la CLI (`telegram-login.mjs`)
 * et le banc de test (`test-bench-app.mjs`).
 *
 * Le cœur vit dans `src/telegram/login.ts` (compilé vers `dist/`) pour que la
 * CLI, le banc et le serveur MCP de supervision utilisent exactement la même
 * logique. Ce fichier n'est qu'un pont, plus le parcours « téléphone » qui
 * reste propre à la CLI (prompts dans le terminal).
 *
 * Trois voies, toutes gratuites, toutes par MTProto (GramJS), aucune API
 * officielle payante ni intermédiaire :
 *
 *  - `QrLoginFlow`    : compte personnel, scan d'un QR code avec le téléphone.
 *  - `botLoginAndSave`: jeton de bot, zéro fichier de session à produire.
 *  - `phoneLogin`     : compte personnel, numéro + code + mot de passe 2FA.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const loginModule = join(here, "..", "dist", "telegram", "login.js");
const sessionModule = join(here, "..", "dist", "telegram", "session.js");
if (!existsSync(loginModule)) {
  console.error(
    "dist/telegram/login.js introuvable. Lancez « npm run build » d'abord (le dépôt ne contient que les sources TypeScript).",
  );
  process.exit(1);
}

const { QrLoginFlow, botLoginAndSave, displayName, qrPayload } = await import(
  pathToFileURL(loginModule).href,
);
const { effectiveSessionFile } = await import(pathToFileURL(sessionModule).href);
export { QrLoginFlow, botLoginAndSave, displayName, effectiveSessionFile, qrPayload };

/**
 * Connexion d'un compte personnel par numéro de téléphone.
 *
 * `handlers.phone()`, `handlers.code()`, `handlers.password(hint)` et
 * `handlers.error(msg)` pilotent l'interaction.
 */
export async function phoneLogin(apiId, apiHash, handlers = {}) {
  const { TelegramClient } = await import("telegram");
  const { StringSession } = await import("telegram/sessions/index.js");
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.connect();

  try {
    await client.start({
      phoneNumber: async () => handlers.phone(),
      phoneCode: async () => handlers.code(),
      password: async (hint) => handlers.password(hint),
      onError: (err) => {
        if (handlers.error) handlers.error(err.message);
        return false;
      },
    });
    const session = client.session.save();
    return { user: await client.getMe(), session };
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}
