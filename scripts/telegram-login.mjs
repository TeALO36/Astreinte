#!/usr/bin/env node
/**
 * Connexion Telegram — VOTRE compte personnel ou un bot, par MTProto (GramJS).
 *
 * Aucune API officielle payante, aucun intermédiaire : un compte personnel
 * apparaît comme un compte utilisateur normal, jamais avec le badge « bot ».
 *
 * Trois modes (nécessite `npm run build` une fois) :
 *
 *   npm run telegram:login            compte personnel, numéro + code
 *   npm run telegram:login:qr         compte personnel, scan d'un QR code
 *   npm run telegram:login:bot        bot, avec son jeton
 *
 * Variables d'environnement (équivalents SNAP_ASTREINTE_* quand l'hôte
 * injecte les secrets) :
 *
 *   TELEGRAM_API_ID / TELEGRAM_API_HASH    créés sur https://my.telegram.org
 *   TELEGRAM_BOT_TOKEN                     jeton de bot, pour le mode bot
 *   TELEGRAM_SESSION_FILE                  où écrire la session (défaut :
 *                                          $SNAP_ASTREINTE_HOME/.telegram/session.txt)
 *
 * Le résultat est une session qui sert à la fois au canal de conversation et
 * aux alertes : un seul compte à gérer.
 */
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  QrLoginFlow,
  botLoginAndSave,
  effectiveSessionFile,
  phoneLogin,
} from "./telegram-auth.mjs";

const apiId = Number(
  process.env.TELEGRAM_API_ID ?? process.env.SNAP_ASTREINTE_TELEGRAM_API_ID ?? "",
);
const apiHash =
  process.env.TELEGRAM_API_HASH ?? process.env.SNAP_ASTREINTE_TELEGRAM_API_HASH;
const sessionFile = effectiveSessionFile(
  process.env.TELEGRAM_SESSION_FILE ??
    process.env.SNAP_ASTREINTE_TELEGRAM_SESSION_FILE ??
    undefined,
);

const args = process.argv.slice(2);
const mode = args.includes("--qr") ? "qr" : args.includes("--bot") ? "bot" : "phone";
let botToken = process.env.TELEGRAM_BOT_TOKEN ?? process.env.SNAP_ASTREINTE_TELEGRAM_BOT_TOKEN;
if (mode === "bot" && !botToken) {
  const i = args.indexOf("--bot");
  const inline = i >= 0 ? args[i + 1] : undefined;
  if (inline && !inline.startsWith("--")) botToken = inline;
}

if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash) {
  console.error(
    "Définissez TELEGRAM_API_ID et TELEGRAM_API_HASH. Créez-les sur https://my.telegram.org (API development tools).",
  );
  process.exit(1);
}
if (mode === "bot" && !botToken) {
  console.error(
    "Mode bot : fournissez le jeton via TELEGRAM_BOT_TOKEN ou « npm run telegram:login:bot -- <jeton> ».",
  );
  process.exit(1);
}

const rl = createInterface({ input, output });
const ask = async (question) => (await rl.question(question)).trim();

try {
  if (mode === "qr") {
    console.log(
      "Connexion par QR code : ouvrez le lien sur votre téléphone, ou scannez-le avec l'application Telegram.",
    );
    const flow = new QrLoginFlow({
      sessionFile,
      onQr: (payload) => console.log(`Lien QR : ${payload.webUrl}`),
      password: (hint) => ask(`Mot de passe 2FA${hint ? ` (indice : ${hint})` : ""} : `),
      onError: (msg) => console.error(`Erreur de connexion : ${msg}`),
    });
    await flow.begin(apiId, apiHash);
    if (flow.status.phase === "done") {
      console.log(
        `Session Telegram enregistrée (${flow.status.user}) dans ${sessionFile}. ` +
          "Gardez-la privée : elle donne un accès complet au compte.",
      );
    } else {
      console.error(`Connexion échouée : ${flow.status.error ?? "inconnue"}`);
      process.exitCode = 1;
    }
  } else if (mode === "bot") {
    const { user, savedTo } = await botLoginAndSave(apiId, apiHash, botToken, sessionFile);
    console.log(
      `Session bot enregistrée (${user}) dans ${savedTo}. ` +
        "Gardez-la privée : elle donne un accès complet au bot.",
    );
  } else {
    const { user, session } = await phoneLogin(apiId, apiHash, {
      phone: () => ask("Numéro de téléphone Telegram (format international) : "),
      code: () => ask("Code reçu dans Telegram : "),
      password: (hint) => ask(`Mot de passe 2FA${hint ? ` (indice : ${hint})` : ""} : `),
      error: (msg) => console.error(`Erreur de connexion : ${msg}`),
    });
    mkdirSync(path.dirname(sessionFile), { recursive: true });
    writeFileSync(sessionFile, session, { mode: 0o600 });
    console.log(
      `Session Telegram enregistrée (${user.username ? `@${user.username}` : "compte"}) dans ${sessionFile}. ` +
        "Gardez-la privée : elle donne un accès complet au compte.",
    );
  }
} catch (e) {
  console.error(`Échec de la connexion : ${e.message}`);
  process.exitCode = 1;
} finally {
  rl.close();
  process.exit(process.exitCode ?? 0);
}
