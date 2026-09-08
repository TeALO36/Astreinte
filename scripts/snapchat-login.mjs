#!/usr/bin/env node
/**
 * Connexion Snapchat Web — une seule fois, avec identifiants.
 *
 *   npm run snapchat:login
 *
 * Lit SNAPCHAT_EMAIL / SNAPCHAT_PASSWORD (variables d'environnement ou fichier
 * `.env` à la racine de l'extension), ouvre une fenêtre Chromium visible,
 * soumet le formulaire e-mail + mot de passe, traverse l'onboarding, puis
 * enregistre la session dans $SNAP_ASTREINTE_HOME/.snapmcp/state.json.
 *
 * Les démarrages suivants (SNAPCHAT_CLIENT=web) relisent ce fichier de session
 * et lancent le navigateur en headless : Snapchat bloque les visites anonymes
 * headless, mais accepte la navigation headless avec une session valide.
 *
 * Captcha ou 2FA éventuel : la fenêtre reste ouverte, terminez à la main puis
 * relancez la commande.
 */
import { loadDotEnv } from "../dist/env.js";
import { WebSnapchatClient } from "../dist/client/index.js";

const envFile = loadDotEnv();
const email = process.env.SNAPCHAT_EMAIL?.trim();
const password = process.env.SNAPCHAT_PASSWORD;

if (!email || !password) {
  console.error(
    "Identifiants absents : définissez SNAPCHAT_EMAIL et SNAPCHAT_PASSWORD " +
      (envFile ? `dans ${envFile}` : "dans l'environnement ou dans extension/.env") + ".",
  );
  process.exit(1);
}

console.log(
  `Connexion Snapchat Web avec ${email} ` +
    "(une fenêtre Chromium s'ouvre — captcha ou 2FA : terminez à la main).",
);

const client = new WebSnapchatClient({ headless: false });
try {
  const status = await client.loginWithCredentials();
  console.log(`\n${status.detail}`);
  console.log(`Session   : ${status.sessionSaved ? "enregistrée" : "NON enregistrée"} (${status.stateFile})`);
  console.log(`URL       : ${status.url}`);
  if (!status.connected) process.exitCode = 1;
} catch (e) {
  console.error(`Échec : ${e.message}`);
  process.exitCode = 1;
} finally {
  await client.close();
  process.exit(process.exitCode ?? 0);
}
