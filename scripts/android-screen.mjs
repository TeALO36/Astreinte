#!/usr/bin/env node
// Regarde et pilote l'écran d'une machine virtuelle Android.
//
// Le banc savait lancer les VM et prendre une capture ; il ne savait pas *lire*
// ce qu'il y a à l'écran, ni y toucher. Une capture PNG ne se compare pas en
// script : c'est l'arbre d'interface qui dit quels textes et quels boutons sont
// là, et c'est `input` qui appuie dessus.
//
// Usage :
//   node scripts/android-screen.mjs                      # décrit l'écran
//   node scripts/android-screen.mjs --tap 540 1200        # appuie
//   node scripts/android-screen.mjs --swipe 540 1600 540 600
//   node scripts/android-screen.mjs --back
//   node scripts/android-screen.mjs --home
//   node scripts/android-screen.mjs --text "bonjour"      # saisit du texte
//   node scripts/android-screen.mjs --keyevent 82         # une touche brute
//   node scripts/android-screen.mjs --serial emulator-5554
//   node scripts/android-screen.mjs --grep "Play"         # échoue si absent
//
// Une action est suivie d'une relecture de l'écran : on voit ce qu'elle a
// produit, sans relancer la commande.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADB, checkSdk, chooseSerial, shell, sleep } from "./lib/android.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const valeur = (n) => {
  const i = args.indexOf(n);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};
const nombres = (n, combien) => {
  const i = args.indexOf(n);
  if (i === -1) return null;
  const pris = args.slice(i + 1, i + 1 + combien).map(Number);
  return pris.length === combien && pris.every((v) => Number.isFinite(v)) ? pris : null;
};

const SORTIE = join(tmpdir(), "astreinte-android-screen");

/** Une coordonnée doit être un entier positif : `input` refuse le reste. */
function coordonnee(v, nom) {
  if (!Number.isInteger(v) || v < 0) {
    throw new Error(`${nom} doit être un entier positif (reçu « ${v} »).`);
  }
  return String(v);
}

/**
 * Les textes visibles, lus dans l'arbre d'interface.
 *
 * Deux attributs portent ce qu'une personne lit : `text` pour le libellé, et
 * `content-desc` pour ce qu'un lecteur d'écran annoncerait — un bouton en icône
 * n'a que le second. Les deux sont pris, dédoublonnés dans l'ordre d'apparition.
 */
export function textesVisibles(xml) {
  const vus = new Set();
  const sortie = [];
  for (const m of xml.matchAll(/(?:text|content-desc)="([^"]*)"/g)) {
    const t = m[1].trim();
    if (!t || vus.has(t)) continue;
    vus.add(t);
    sortie.push(decodeXml(t));
  }
  return sortie;
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * L'arbre d'interface courant.
 *
 * `uiautomator dump` écrit sur le disque de l'appareil puis on relit : c'est
 * plus sûr que `--stdout`, que certaines versions accompagnent d'une ligne de
 * courtoisie collée au XML.
 */
async function arbreInterface(serial) {
  const dump = await shell(serial, "uiautomator dump /sdcard/window_dump.xml", 30000);
  if (!dump.ok && !/dumped/i.test(dump.stdout + dump.stderr)) {
    return { ok: false, raison: (dump.stderr || dump.stdout).trim() };
  }
  const lu = await shell(serial, "cat /sdcard/window_dump.xml", 30000);
  if (!lu.ok || !lu.stdout.includes("<hierarchy")) {
    return { ok: false, raison: (lu.stderr || lu.stdout).trim() || "arbre illisible" };
  }
  await shell(serial, "rm -f /sdcard/window_dump.xml", 10000);
  return { ok: true, xml: lu.stdout };
}

/** La capture d'écran, écrite telle quelle : `exec-out` rend le PNG brut. */
async function capture(serial, fichier) {
  const child = spawn(ADB, ["-s", serial, "exec-out", "screencap", "-p"], {
    windowsHide: true,
  });
  const morceaux = [];
  child.stdout.on("data", (d) => morceaux.push(d));
  await new Promise((resolve) => child.on("close", resolve));
  if (!morceaux.length) return null;
  try {
    writeFileSync(fichier, Buffer.concat(morceaux));
    return fichier;
  } catch {
    return null;
  }
}

async function decrireEcran(serial) {
  const boot = await shell(serial, "getprop sys.boot_completed", 15000);
  const taille = await shell(serial, "wm size", 15000);
  const focus = await shell(serial, "dumpsys window windows", 30000);

  mkdirSync(SORTIE, { recursive: true });
  const png = await capture(serial, join(SORTIE, `${serial}.png`));
  const arbre = await arbreInterface(serial);

  let textes = [];
  if (arbre.ok) {
    writeFileSync(join(SORTIE, `${serial}.xml`), arbre.xml);
    textes = textesVisibles(arbre.xml);
  }

  const auPremierPlan = (focus.stdout || "")
    .split(/\r?\n/)
    .filter((l) => /mCurrentFocus|mFocusedApp/.test(l))
    .map((l) => l.trim())
    .join(" | ");

  return {
    serial,
    bootComplet: boot.ok && boot.stdout.trim() === "1",
    taille: (taille.stdout || "").trim().replace(/^Physical size:\s*/, "") || "(inconnue)",
    auPremierPlan: auPremierPlan || "(aucune fenêtre au premier plan)",
    capture: png,
    arbre: arbre.ok ? join(SORTIE, `${serial}.xml`) : null,
    arbreErreur: arbre.ok ? null : arbre.raison,
    textes,
  };
}

async function agir(serial) {
  const tap = nombres("--tap", 2);
  const swipe = nombres("--swipe", 4);
  const texte = valeur("--text");
  const touche = valeur("--keyevent");

  if (tap) {
    const [x, y] = tap;
    await shell(serial, `input tap ${coordonnee(x, "x")} ${coordonnee(y, "y")}`, 20000);
    return `appui en (${x}, ${y})`;
  }
  if (swipe) {
    const [x1, y1, x2, y2] = swipe;
    const duree = Number(valeur("--duration")) || 300;
    await shell(
      serial,
      `input swipe ${coordonnee(x1, "x1")} ${coordonnee(y1, "y1")} ${coordonnee(
        x2,
        "x2",
      )} ${coordonnee(y2, "y2")} ${duree}`,
      20000,
    );
    return `glissement de (${x1}, ${y1}) vers (${x2}, ${y2}) en ${duree} ms`;
  }
  if (flag("--back")) {
    await shell(serial, "input keyevent 4", 15000);
    return "retour";
  }
  if (flag("--home")) {
    await shell(serial, "input keyevent 3", 15000);
    return "accueil";
  }
  if (texte !== null) {
    // `input text` ne prend pas d'espace : il attend %s. Le reste passe tel
    // quel, entre guillemets, pour survivre au shell de l'appareil.
    const encode = texte.replace(/ /g, "%s");
    await shell(serial, `input text "${encode}"`, 20000);
    return `saisie de « ${texte} »`;
  }
  if (touche !== null) {
    const n = Number(touche);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`--keyevent attend un code de touche entier (reçu « ${touche} »).`);
    }
    await shell(serial, `input keyevent ${n}`, 15000);
    return `touche ${n}`;
  }
  return null;
}

async function main() {
  const sdk = checkSdk();
  if (!sdk.ok) {
    console.error(`ERREUR : ${sdk.raison}`);
    process.exit(1);
  }

  const serial = await chooseSerial(valeur("--serial"));
  const action = await agir(serial);
  if (action) {
    console.log(`Action : ${action}`);
    // L'interface a besoin d'un instant pour suivre : relire trop tôt montre
    // l'écran d'avant, ce qui donne à croire que l'action n'a rien fait.
    await sleep(800);
  }

  const e = await decrireEcran(serial);
  console.log("=".repeat(72));
  console.log(`Appareil       : ${e.serial}`);
  console.log(`Boot terminé   : ${e.bootComplet ? "oui" : "non"}`);
  console.log(`Taille         : ${e.taille}`);
  console.log(`Premier plan   : ${e.auPremierPlan}`);
  console.log(`Capture        : ${e.capture ?? "(échouée)"}`);
  console.log(`Arbre          : ${e.arbre ?? `(illisible : ${e.arbreErreur})`}`);
  console.log("=".repeat(72));
  if (e.textes.length) {
    console.log("Textes à l'écran :");
    for (const t of e.textes) console.log(`  · ${t}`);
  } else {
    console.log("Aucun texte lisible à l'écran.");
  }

  const cherche = valeur("--grep");
  if (cherche) {
    const trouve = e.textes.some((t) => t.toLowerCase().includes(cherche.toLowerCase()));
    console.log("");
    console.log(trouve ? `« ${cherche} » est à l'écran.` : `« ${cherche} » est ABSENT de l'écran.`);
    if (!trouve) process.exit(1);
  }
}

// Importé par les tests : on ne lance rien dans ce cas.
if (process.argv[1] && process.argv[1].endsWith("android-screen.mjs")) {
  main().catch((e) => {
    console.error(`ERREUR : ${e.message}`);
    process.exit(1);
  });
}
