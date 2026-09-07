// Le socle commun des scripts Android du banc : trouver le SDK, lancer un
// outil, parler à un appareil.
//
// Ces trois choses étaient recopiées dans chaque script. Trois copies d'une
// règle de chemin finissent par ne plus s'accorder sur un cas limite — un SDK
// installé ailleurs, un `cmdline-tools` d'une autre génération — et le script
// qui se trompe échoue en annonçant que le SDK est absent.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const EXE = process.platform === "win32" ? ".exe" : "";
const BAT = process.platform === "win32" ? ".bat" : "";

/** La racine du SDK Android, ou `null` si aucune ne répond. */
export function sdkRoot() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.platform === "win32" ? join(process.env.LOCALAPPDATA || "", "Android", "Sdk") : null,
    process.platform === "win32" ? "C:\\Android\\sdk" : null,
    join(homedir(), "Android", "Sdk"),
    "/usr/lib/android-sdk",
    "/opt/android-sdk",
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || null;
}

/**
 * Le chemin d'un outil du SDK.
 *
 * `sdkmanager` et `avdmanager` ont changé de place au fil des versions du SDK :
 * `cmdline-tools/latest/bin` aujourd'hui, `cmdline-tools/bin` sur une
 * installation faite à la main, `tools/bin` avant. Les trois sont essayées,
 * sinon on rend le nom nu — le `PATH` peut encore le trouver.
 */
export function sdkTool(root, name) {
  if (!root) return name;
  const emplacements = [
    join(root, "cmdline-tools", "latest", "bin"),
    join(root, "cmdline-tools", "bin"),
    join(root, "tools", "bin"),
    join(root, "platform-tools"),
    join(root, "emulator"),
  ];
  for (const dir of emplacements) {
    for (const suffixe of [BAT, EXE, ""]) {
      const candidat = join(dir, `${name}${suffixe}`);
      if (existsSync(candidat)) return candidat;
    }
  }
  return name;
}

const sdk = sdkRoot();

export const ANDROID_HOME = sdk;
export const ADB = sdk ? join(sdk, "platform-tools", `adb${EXE}`) : "adb";
export const EMULATOR = sdk ? join(sdk, "emulator", `emulator${EXE}`) : "emulator";
export const SDKMANAGER = sdkTool(sdk, "sdkmanager");
export const AVDMANAGER = sdkTool(sdk, "avdmanager");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Lance une commande et rend ce qu'elle a dit.
 *
 * Ne rejette jamais : un outil absent, un délai dépassé et un code de retour
 * non nul sont tous des réponses, pas des accidents. `stdin` sert aux outils
 * qui posent des questions — `sdkmanager` demande d'accepter des licences.
 */
export function run(cmd, cmdArgs, { timeoutMs = 30000, stdin = null, onLine = null } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let fini = false;
    let child;
    const timer = setTimeout(() => {
      if (fini) return;
      fini = true;
      resolve({ ok: false, code: null, stdout: out, stderr: err, timedOut: true });
      try {
        child?.kill();
      } catch {
        // Le processus était déjà parti : rien à tuer.
      }
    }, timeoutMs);

    try {
      child = spawn(cmd, cmdArgs, { windowsHide: true });
    } catch (e) {
      clearTimeout(timer);
      return resolve({ ok: false, code: null, stdout: "", stderr: e.message });
    }

    child.stdout.on("data", (d) => {
      out += d;
      if (onLine) for (const l of String(d).split(/\r?\n/)) if (l.trim()) onLine(l);
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", (e) => {
      if (fini) return;
      fini = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout: out, stderr: e.message });
    });
    child.on("close", (code) => {
      if (fini) return;
      fini = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: out, stderr: err });
    });

    if (stdin !== null) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

export const adb = (serial, cmdArgs, timeoutMs) =>
  run(ADB, ["-s", serial, ...cmdArgs], { timeoutMs });

export const shell = (serial, command, timeoutMs) => adb(serial, ["shell", command], { timeoutMs });

/** Les appareils qu'`adb` voit, avec leur état. */
export function parseDevices(stdout) {
  return stdout
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && p[0])
    .map((p) => ({ serial: p[0], state: p[1] }));
}

export async function listDevices() {
  const r = await run(ADB, ["devices"]);
  return r.ok ? parseDevices(r.stdout) : [];
}

/** Les AVD créés sur cette machine. */
export async function listAvds() {
  const r = await run(EMULATOR, ["-list-avds"]);
  return r.ok
    ? r.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
    : [];
}

/**
 * L'appareil sur lequel agir.
 *
 * Sans demande explicite, le seul appareil prêt. S'il y en a plusieurs, on
 * refuse plutôt que d'en choisir un : agir sur la mauvaise VM est plus coûteux
 * qu'une question.
 */
export async function chooseSerial(requested) {
  const devices = await listDevices();
  if (requested) {
    const hit = devices.find((d) => d.serial === requested);
    if (!hit) {
      throw new Error(
        `L'appareil « ${requested} » n'est pas connecté. Connectés : ${
          devices.map((d) => d.serial).join(", ") || "aucun"
        }`,
      );
    }
    return hit.serial;
  }
  const prets = devices.filter((d) => d.state === "device");
  if (prets.length === 0) {
    throw new Error(
      "Aucun appareil Android connecté. Lancez le banc : npm run android:vms",
    );
  }
  if (prets.length > 1) {
    throw new Error(
      `Plusieurs appareils connectés (${prets
        .map((d) => d.serial)
        .join(", ")}). Précisez lequel avec --serial.`,
    );
  }
  return prets[0].serial;
}

/** Le SDK est-il utilisable, et si non, ce qui manque. */
export function checkSdk({ needEmulator = false, needCmdlineTools = false } = {}) {
  if (!ANDROID_HOME) {
    return {
      ok: false,
      raison:
        "SDK Android introuvable. Posez ANDROID_HOME sur sa racine, ou installez-le.",
    };
  }
  if (!existsSync(ADB)) {
    return {
      ok: false,
      raison: `adb manquant (${ADB}). Installez « platform-tools » : npm run android:provision -- --install`,
    };
  }
  if (needEmulator && !existsSync(EMULATOR)) {
    return {
      ok: false,
      raison: `emulator manquant (${EMULATOR}). Installez-le : npm run android:provision -- --install`,
    };
  }
  if (needCmdlineTools && !existsSync(SDKMANAGER)) {
    return {
      ok: false,
      raison:
        "sdkmanager introuvable. Installez « Android SDK Command-line Tools » depuis Android Studio, ou dépliez cmdline-tools dans le SDK.",
    };
  }
  return { ok: true };
}
