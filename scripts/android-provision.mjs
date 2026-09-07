#!/usr/bin/env node
// Prépare le SDK Android et crée les trois machines virtuelles du banc.
//
// `android-vms.mjs` sait lancer les VM, mais s'arrête net quand elles n'existent
// pas encore : « ERREUR : AVD manquants ». C'est ce trou que ce script comble —
// installer les composants, puis créer les AVD.
//
// Usage :
//   node scripts/android-provision.mjs                # état des lieux, ne change rien
//   node scripts/android-provision.mjs --install       # installe les composants du SDK
//   node scripts/android-provision.mjs --create-avds   # crée les AVD manquants
//   node scripts/android-provision.mjs --all           # les deux
//   node scripts/android-provision.mjs --api 34        # viser une autre API (défaut 35)
//   node scripts/android-provision.mjs --force         # recréer un AVD qui existe déjà
//
// L'état des lieux est le comportement par défaut, et c'est voulu :
// l'installation télécharge plusieurs gigaoctets et écrit dans le SDK de la
// machine. Cela se demande, cela ne se déclenche pas parce qu'on a lancé un
// script pour voir.

import { existsSync } from "node:fs";
import {
  ANDROID_HOME,
  AVDMANAGER,
  EMULATOR,
  SDKMANAGER,
  checkSdk,
  listAvds,
  run,
} from "./lib/android.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const valeur = (n, defaut) => {
  const i = args.indexOf(n);
  return i !== -1 && args[i + 1] ? args[i + 1] : defaut;
};

const opts = {
  install: flag("--install") || flag("--all"),
  createAvds: flag("--create-avds") || flag("--all"),
  force: flag("--force"),
  api: String(Number(valeur("--api", "35")) || 35),
};

/** Les trois VM du banc, et le profil d'appareil de chacune. */
const VMS = [
  { name: "SnapMCP_API35", device: "pixel_5", label: "Pixel 5" },
  { name: "SnapMCP_Pixel7_API35", device: "pixel_7", label: "Pixel 7" },
  { name: "SnapMCP_PixelFold_API35", device: "pixel_fold", label: "Pixel Fold" },
];

/**
 * L'image système du banc.
 *
 * `google_apis_playstore` et non `google_apis` : le banc vérifie que le Play
 * Store s'ouvre, et il n'est présent que dans les images qui l'embarquent.
 */
const imageSysteme = (api) => `system-images;android-${api};google_apis_playstore;x86_64`;

const composants = (api) => [
  "platform-tools",
  "emulator",
  `platforms;android-${api}`,
  imageSysteme(api),
];

const ligne = () => console.log("=".repeat(72));

async function etatDesLieux() {
  const installes = await listAvds();
  const image = imageSysteme(opts.api);
  const imagePosee =
    ANDROID_HOME &&
    existsSync(
      `${ANDROID_HOME}/system-images/android-${opts.api}/google_apis_playstore/x86_64`,
    );

  console.log(`SDK        : ${ANDROID_HOME ?? "(introuvable)"}`);
  console.log(`emulator   : ${existsSync(EMULATOR) ? "présent" : "MANQUANT"}`);
  console.log(`sdkmanager : ${existsSync(SDKMANAGER) ? "présent" : "MANQUANT"}`);
  console.log(`image      : ${imagePosee ? "présente" : "MANQUANTE"} — ${image}`);
  console.log("");
  console.log("Machines virtuelles du banc :");
  for (const vm of VMS) {
    const etat = installes.includes(vm.name) ? "créée" : "MANQUANTE";
    console.log(`  ${etat.padEnd(9)} ${vm.name}  (${vm.label})`);
  }
  return { installes, imagePosee };
}

/**
 * Installe les composants, en acceptant les licences.
 *
 * `sdkmanager` pose la question sur son entrée standard et attend une réponse
 * par paquet : sans elle il reste suspendu jusqu'au délai, et le script paraît
 * bloqué sans rien dire.
 */
async function installer() {
  const liste = composants(opts.api);
  console.log("");
  ligne();
  console.log("Installation des composants du SDK");
  ligne();
  for (const c of liste) console.log(`  · ${c}`);
  console.log("");
  console.log("Le téléchargement pèse plusieurs gigaoctets. Cela peut être long.");
  console.log("");

  const r = await run(SDKMANAGER, [...liste, `--sdk_root=${ANDROID_HOME}`], {
    // Une image système se télécharge en dizaines de minutes sur une ligne
    // ordinaire : le délai doit tenir compte du pire cas, pas du meilleur.
    timeoutMs: 90 * 60 * 1000,
    stdin: "y\n".repeat(liste.length + 5),
    onLine: (l) => {
      if (/%|Installing|Downloading|Unzipping|Warning|Error/i.test(l)) {
        console.log(`  ${l.trim()}`);
      }
    },
  });

  if (!r.ok) {
    console.error("");
    console.error("ERREUR : l'installation a échoué.");
    console.error((r.stderr || r.stdout).trim().split(/\r?\n/).slice(-8).join("\n"));
    return false;
  }
  console.log("  Composants installés.");
  return true;
}

/**
 * Crée les AVD manquants.
 *
 * `--force` de `avdmanager` écraserait un AVD existant — donc ses snapshots et
 * ses données. On ne le passe que si la personne l'a demandé, et on saute les
 * AVD déjà là plutôt que de les remplacer par surprise.
 */
async function creerAvds(installes) {
  console.log("");
  ligne();
  console.log("Création des machines virtuelles");
  ligne();

  const image = imageSysteme(opts.api);
  let echecs = 0;

  for (const vm of VMS) {
    const existe = installes.includes(vm.name);
    if (existe && !opts.force) {
      console.log(`  ${vm.name} : déjà créée, laissée telle quelle`);
      continue;
    }

    const cmdArgs = [
      "create",
      "avd",
      "-n",
      vm.name,
      "-k",
      image,
      "-d",
      vm.device,
      "--abi",
      "x86_64",
    ];
    if (existe && opts.force) cmdArgs.push("--force");

    // `avdmanager` propose un profil matériel personnalisé et attend une
    // réponse : « no » garde celui du profil d'appareil demandé.
    const r = await run(AVDMANAGER, cmdArgs, { timeoutMs: 120000, stdin: "no\n" });
    if (r.ok) {
      console.log(`  ${vm.name} : créée (${vm.label})`);
    } else {
      echecs += 1;
      console.error(`  ${vm.name} : ÉCHEC`);
      console.error(`    ${(r.stderr || r.stdout).trim().split(/\r?\n/).slice(-3).join("\n    ")}`);
    }
  }
  return echecs === 0;
}

async function main() {
  ligne();
  console.log("Préparation du banc Android");
  ligne();

  const sdk = checkSdk({ needCmdlineTools: opts.install || opts.createAvds });
  if (!sdk.ok && (opts.install || opts.createAvds)) {
    console.error(`ERREUR : ${sdk.raison}`);
    process.exit(1);
  }

  const { installes, imagePosee } = await etatDesLieux();

  if (!opts.install && !opts.createAvds) {
    console.log("");
    console.log("Rien n'a été modifié. Pour agir :");
    console.log("  npm run android:provision -- --install       (composants du SDK)");
    console.log("  npm run android:provision -- --create-avds   (machines virtuelles)");
    console.log("  npm run android:provision -- --all           (les deux)");
    return;
  }

  if (opts.install && !(await installer())) process.exit(1);

  if (opts.createAvds) {
    if (!imagePosee && !opts.install) {
      console.error("");
      console.error(
        `ERREUR : l'image système ${imageSysteme(opts.api)} n'est pas installée.`,
      );
      console.error("Un AVD ne peut pas être créé sans elle : ajoutez --install.");
      process.exit(1);
    }
    // La liste est relue : l'installation a pu en changer l'état.
    const apres = await listAvds();
    if (!(await creerAvds(apres))) process.exit(1);
  }

  console.log("");
  ligne();
  console.log("Prêt. Lancez le banc : npm run android:vms");
  ligne();
}

main().catch((e) => {
  console.error(`ERREUR : ${e.message}`);
  process.exit(1);
});
