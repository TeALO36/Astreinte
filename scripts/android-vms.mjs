#!/usr/bin/env node
// Lance les trois machines virtuelles Android du banc, attend la fin du boot,
// ouvre le Play Store sur chacune et vérifie qu'il est bien à l'écran.
//
// PRÉREQUIS (créés une fois via sdkmanager/avdmanager — procédure vérifiée) :
//   sdkmanager "emulator" "system-images;android-35;google_apis_playstore;x86_64"
//   avdmanager create avd -n SnapMCP_API35 -k "system-images;android-35;google_apis_playstore;x86_64" -d pixel_5
//   ⚠ sur Windows, si le SDK n'est pas à l'endroit par défaut, avdmanager peut
//   écrire un mauvais image.sysdir.1 dans l'AVD : corriger en
//   `system-images\android-35\google_apis_playstore\x86_64\` et lancer
//   l'émulateur avec ANDROID_SDK_ROOT défini.
//
// COMPTE GOOGLE (Play Store) : le compte du .env (GOOGLE_EMAIL/PASSWORD) se
// connecte sans mot de passe ni captcha sur l'AVD — vérifié 09/2026.
// SNAPCHAT S'INSTALLE depuis le Play Store sur un AVD Google Play (v14.22
// vérifiée) et se LANCE, mais la CONNEXION par identifiants se heurte à un
// refus silencieux (pare-feu anti-émulateur) : la première tentative passe
// (prompt « Save password » = identifiants acceptés), les suivantes sont
// ignorées sans erreur. Une seule tentative par session — voir AdbSnapchatClient.login().
//
// Usage :
//   node scripts/android-vms.mjs                 # démarre tout, fenêtres visibles
//   node scripts/android-vms.mjs --no-window     # sans fenêtre (CI, serveur)
//   node scripts/android-vms.mjs --cold          # boot complet, sans snapshot
//   node scripts/android-vms.mjs --check-only    # vérifie des VM déjà lancées
//   node scripts/android-vms.mjs --quit-after-check   # arrête les VM après la vérification
//   node scripts/android-vms.mjs --memory 2048   # RAM invité par VM (Mo, défaut 1536)
//
// Le Play Store ne nécessite aucun compte : il suffit qu'il s'ouvre et reste au
// premier plan. Les captures d'écran sont écrites dans le dossier temporaire
// indiqué en fin de sortie.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const VMS = [
  { name: "SnapMCP_API35", port: 5554, label: "Pixel 5 — API 35 (Google Play)" },
  { name: "SnapMCP_Pixel7_API35", port: 5556, label: "Pixel 7 — API 35 (Google Play)" },
  { name: "SnapMCP_PixelFold_API35", port: 5558, label: "Pixel Fold — API 35 (Google Play)" },
];

const PLUGIN = /(com\.android\.vending|com\.google\.android\.finsky)/;

function sdkRoot() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.platform === "win32" ? join(process.env.LOCALAPPDATA || "", "Android", "Sdk") : null,
    join(homedir(), "Android", "Sdk"),
    "/usr/lib/android-sdk",
    "/opt/android-sdk",
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || null;
}

const ANDROID_HOME = sdkRoot();
const ADB = ANDROID_HOME ? join(ANDROID_HOME, "platform-tools", `adb${process.platform === "win32" ? ".exe" : ""}`) : "adb";
const EMULATOR = ANDROID_HOME ? join(ANDROID_HOME, "emulator", `emulator${process.platform === "win32" ? ".exe" : ""}`) : "emulator";

const args = process.argv.slice(2);
const opts = {
  noWindow: args.includes("--no-window"),
  cold: args.includes("--cold"),
  checkOnly: args.includes("--check-only"),
  quitAfterCheck: args.includes("--quit-after-check"),
  memory: Number(args[args.indexOf("--memory") + 1]) || 1536,
  bootTimeoutMs: Number(args[args.indexOf("--boot-timeout") + 1]) || 300000,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, cmdArgs, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; resolve({ ok: false, code: null, stdout: out, stderr: err, timedOut: true }); child.kill(); }
    }, timeoutMs);
    let child;
    try {
      child = spawn(cmd, cmdArgs, { windowsHide: true });
    } catch (e) {
      clearTimeout(timer);
      return resolve({ ok: false, code: null, stdout: "", stderr: e.message });
    }
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => {
      if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, code: null, stdout: out, stderr: e.message }); }
    });
    child.on("close", (code) => {
      if (!done) { done = true; clearTimeout(timer); resolve({ ok: code === 0, code, stdout: out, stderr: err }); }
    });
  });
}

const adb = (serial, cmdArgs, timeoutMs) => run(ADB, ["-s", serial, ...cmdArgs], timeoutMs);
const shell = (serial, command, timeoutMs) => adb(serial, ["shell", command], timeoutMs);

async function waitForBoot(serial) {
  const deadline = Date.now() + opts.bootTimeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const r = await shell(serial, "getprop sys.boot_completed", 15000);
    if (r.ok && r.stdout.trim() === "1") return { ok: true };
    last = r.ok ? r.stdout.trim() : r.stderr.trim();
    const still = await shell(serial, "getprop init.svc.bootanim", 10000);
    if (!still.ok) await sleep(2000);
    await sleep(5000);
  }
  return { ok: false, last };
}

function startEmulator(vm) {
  const cmdArgs = [
    "-avd", vm.name,
    "-port", String(vm.port),
    "-no-boot-anim",
    "-gpu", "swiftshader_indirect",
    "-memory", String(opts.memory),
  ];
  if (opts.noWindow) cmdArgs.push("-no-window");
  if (opts.cold) { cmdArgs.push("-no-snapshot-load", "-no-snapshot-save"); }
  const child = spawn(EMULATOR, cmdArgs, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  child.stderr.on("data", () => {});
  child.on("error", (e) => { console.error(`  ${vm.name} : échec au démarrage (${e.message})`); });
  return child;
}

async function postBoot(serial) {
  await shell(serial, "input keyevent 82", 10000);            // déverrouiller l'écran
  await shell(serial, "svc power stayon true", 10000);        // écran toujours allumé
  await shell(serial, "settings put global window_animation_scale 0", 10000);
  await shell(serial, "settings put global transition_animation_scale 0", 10000);
  await shell(serial, "settings put global animator_duration_scale 0", 10000);
}

async function packageInstalled(serial) {
  const r = await shell(serial, "pm list packages com.android.vending", 20000);
  return r.ok && r.stdout.includes("com.android.vending");
}

async function openPlayStore(serial) {
  // monkey est la façon la plus robuste de lancer l'activité de lancement du Play Store.
  return shell(serial, "monkey -p com.android.vending -c android.intent.category.LAUNCHER 1", 30000);
}

async function currentFocus(serial) {
  const w = await shell(serial, "dumpsys window windows", 30000);
  const a = await shell(serial, "dumpsys activity activities", 30000);
  const wLines = (w.stdout || "").split(/\r?\n/).filter((l) => /mCurrentFocus|mFocusedApp/.test(l)).join(" | ");
  const aLines = (a.stdout || "").split(/\r?\n/).filter((l) => /topResumedActivity|ResumedActivity/.test(l)).join(" | ");
  return `${wLines} ${aLines}`;
}

async function verifyPlayStore(serial) {
  const focus = await currentFocus(serial);
  const onScreen = PLUGIN.test(focus);
  return { onScreen, focus: focus.trim() || "(aucune fenêtre au premier plan)" };
}

async function screenshot(serial, file) {
  const child = spawn(ADB, ["-s", serial, "exec-out", "screencap", "-p"], { windowsHide: true });
  const chunks = [];
  child.stdout.on("data", (d) => chunks.push(d));
  await new Promise((resolve) => child.on("close", resolve));
  if (!chunks.length) return false;
  try { writeFileSync(file, Buffer.concat(chunks)); return true; } catch { return false; }
}

function parseDevices(stdout) {
  return stdout
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && p[0])
    .map((p) => ({ serial: p[0], state: p[1] }));
}

async function listAvds() {
  const r = await run(EMULATOR, ["-list-avds"]);
  return r.ok ? r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
}

async function main() {
  console.log("=".repeat(72));
  console.log("Machines virtuelles Android — banc de test SnapMCP");
  console.log("=".repeat(72));

  if (!ANDROID_HOME || !existsSync(EMULATOR)) {
    console.error("ERREUR : SDK Android introuvable (ANDROID_HOME absent ou emulator manquant).");
    process.exit(1);
  }
  console.log(`SDK   : ${ANDROID_HOME}`);
  console.log(`ADB   : ${ADB}`);
  console.log(`Mode  : ${opts.noWindow ? "sans fenêtre" : "fenêtres visibles"}${opts.cold ? ", boot complet" : ", démarrage rapide (snapshot)"}`);

  const installedAvds = await listAvds();
  const missing = VMS.filter((vm) => !installedAvds.includes(vm.name));
  if (missing.length) {
    console.error(`ERREUR : AVD manquants : ${missing.map((m) => m.name).join(", ")}`);
    process.exit(1);
  }

  const devices = parseDevices((await run(ADB, ["devices"])).stdout);
  const results = [];
  const shotsDir = join(tmpdir(), "snapmcp-android-vms");
  mkdirSync(shotsDir, { recursive: true });

  // 1. Démarrer les trois VM d'un coup (ou reprendre celles déjà connectées).
  const serialOf = (vm) => `emulator-${vm.port}`;
  for (const vm of VMS) {
    const serial = serialOf(vm);
    const existing = devices.find((d) => d.serial === serial);
    process.stdout.write(`▶ ${vm.label}  (${vm.name} — ${serial})\n`);
    if (existing) {
      process.stdout.write(`  déjà connectée (${existing.state}), on la réutilise.\n`);
    } else if (opts.checkOnly) {
      process.stdout.write(`  non lancée (mode --check-only).\n`);
    } else {
      process.stdout.write(`  démarrage de l'émulateur…\n`);
      startEmulator(vm);
      await sleep(3000);
    }
  }

  // 2. Attendre la fin du boot, puis ouvrir et vérifier le Play Store sur chacune.
  for (const vm of VMS) {
    const serial = serialOf(vm);
    const already = devices.find((d) => d.serial === serial);
    if (!already && opts.checkOnly) {
      results.push({ vm, boot: false, store: false, skipped: true });
      continue;
    }
    process.stdout.write(`\n${vm.name} — attente de la fin du boot…\n`);
    const boot = await waitForBoot(serial);
    if (!boot.ok) {
      process.stdout.write(`  ÉCHEC du boot (${boot.last || "délai dépassé"}).\n`);
      results.push({ vm, boot: false, store: false, error: boot.last });
      continue;
    }
    await postBoot(serial);

    const installed = await packageInstalled(serial);
    if (!installed) {
      process.stdout.write(`  ÉCHEC : com.android.vending absent de l'image.\n`);
      results.push({ vm, boot: true, store: false, error: "Play Store absent" });
      continue;
    }

    process.stdout.write(`  ouverture du Play Store…\n`);
    await openPlayStore(serial);
    await sleep(10000);
    let check = await verifyPlayStore(serial);
    if (!check.onScreen) {
      await sleep(10000);
      check = await verifyPlayStore(serial);
    }
    const shot = join(shotsDir, `${vm.name}.png`);
    const captured = await screenshot(serial, shot);
    process.stdout.write(
      `  ${check.onScreen ? "OK — Play Store à l'écran" : "ÉCHEC — le Play Store n'est pas au premier plan"} (${captured ? shot : "capture impossible"})\n`
    );
    results.push({ vm, boot: true, store: check.onScreen, focus: check.focus, shot: captured ? shot : null, installed });
  }

  console.log("\n" + "=".repeat(72));
  console.log("Résultat");
  console.log("=".repeat(72));
  let allOk = true;
  for (const r of results) {
    const ok = r.boot && r.store;
    if (!ok) allOk = false;
    console.log(
      `• ${r.vm.label.padEnd(32)} boot ${r.boot ? "OK" : "ÉCHEC".padEnd(4)} · Play Store ${r.store ? "ouvert ✔" : "non vérifié ✘"}`
    );
    if (r.error) console.log(`    ${r.error}`);
    if (r.focus) console.log(`    fenêtre : ${r.focus}`);
  }
  console.log(`\nCaptures d'écran : ${shotsDir}`);
  console.log(`Les VM ${opts.quitAfterCheck ? "sont arrêtées (--quit-after-check)." : "restent lancées. Pour les arrêter : adb -s emulator-XXXX emu kill"}`);

  const running = results.filter((r) => r.boot && r.store).length;
  const total = VMS.length;
  console.log(`\n${running}/${total} machines virtuelles opérationnelles, Play Store ouvert.`);
  if (opts.quitAfterCheck) {
    for (const vm of VMS) {
      await run(ADB, ["-s", `emulator-${vm.port}`, "emu", "kill"], 15000);
    }
  }
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
