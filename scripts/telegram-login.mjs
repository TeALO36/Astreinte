#!/usr/bin/env node
/**
 * Connexion Telegram avec VOTRE compte personnel (MTProto, via GramJS).
 *
 * Aucun bot, aucune API officielle, aucun intermédiaire : le compte apparaît
 * comme un compte utilisateur normal, jamais avec le badge « bot ».
 *
 *   TELEGRAM_API_ID / TELEGRAM_API_HASH   créés sur https://my.telegram.org
 *   (équivalents SNAP_ASTREINTE_TELEGRAM_API_ID / ..._API_HASH)
 *   TELEGRAM_SESSION_FILE                 où écrire la session (défaut
 *   SNAP_ASTREINTE_TELEGRAM_SESSION_FILE  .telegram/session.txt)
 *
 * Le résultat est une session qui sert à la fois au canal de conversation et
 * aux alertes : un seul compte à gérer.
 */
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const apiId = Number(
  process.env.TELEGRAM_API_ID ?? process.env.SNAP_ASTREINTE_TELEGRAM_API_ID ?? "",
);
const apiHash =
  process.env.TELEGRAM_API_HASH ?? process.env.SNAP_ASTREINTE_TELEGRAM_API_HASH;
const sessionFile =
  process.env.TELEGRAM_SESSION_FILE ??
  process.env.SNAP_ASTREINTE_TELEGRAM_SESSION_FILE ??
  ".telegram/session.txt";

if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash) {
  console.error(
    "Set TELEGRAM_API_ID and TELEGRAM_API_HASH first. Create them at https://my.telegram.org (API development tools).",
  );
  process.exit(1);
}

const rl = createInterface({ input, output });
const ask = async (question) => (await rl.question(question)).trim();
const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
  connectionRetries: 5,
});

try {
  await client.start({
    phoneNumber: async () => ask("Telegram phone number (international format): "),
    phoneCode: async () => ask("Code received in Telegram: "),
    password: async () => ask("Telegram 2FA password (if enabled): "),
    onError: (error) => {
      console.error(`Telegram login error: ${error.message}`);
      return false;
    },
  });

  const me = await client.getMe();
  if (!me || !me.id) {
    throw new Error("Session Telegram invalide : le compte n'a pas pu être vérifié.");
  }

  const session = client.session.save();
  mkdirSync(path.dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, session, { mode: 0o600 });
  console.log(
    `Telegram session saved to ${sessionFile}. Keep it private — it grants full access to your account.`,
  );
} finally {
  rl.close();
  await client.disconnect();
}
