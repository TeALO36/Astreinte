#!/usr/bin/env node
// Lance les trois machines virtuelles Android du banc, attend la fin du boot,
// ouvre le Play Store sur chacune et vérifie qu'il est bien à l'écran.
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
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADB,
  ANDROID_HOME,
  EMULATOR,
  adb,
  checkSdk,
  listAvds,
  parseDevices,
  run,
  shell,
  sleep,
} from "./lib/android.mjs";

const VMS = [
  { name: "SnapMCP_API35", port: 5554, label: "Pixel 5 — API 35 (Google Play)" },
  { name: "SnapMCP_Pixel7_API35", port: 5556, label: "Pixel 7 — API 35 (Google Play)" },
  { name: "SnapMCP_PixelFold_API35", port: 5558, label: "Pixel Fold — API 35 (Google Play)" },
];

const PLUGIN = /(com\.android\.vending|com\.google\.android\.finsky)/;

const args = process.argv.slice(2);
const opts = {
  noWindow: args.includes("--no-window"),
  cold: args.includes("--cold"),
  checkOnly: args.includes("--check-only"),
  quitAfterCheck: args.includes("--quit-after-check"),
  memory: Number(args[args.indexOf("--memory") + 1]) || 1536,
  bootTimeoutMs: Number(args[args.indexOf("--boot-timeout") + 1]) || 300000,
};

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

async function main() {
  console.log("=".repeat(72));
  console.log("Machines virtuelles Android — banc de test SnapMCP");
  console.log("=".repeat(72));

  // Le contrôle partagé distingue ce qui manque : l'ancien message accusait
  // ANDROID_HOME même quand le SDK était bien là et que seul l'émulateur
  // manquait, ce qui envoyait chercher au mauvais endroit.
  const sdk = checkSdk({ needEmulator: true });
  if (!sdk.ok) {
    console.error(`ERREUR : ${sdk.raison}`);
    process.exit(1);
  }
  console.log(`SDK   : ${ANDROID_HOME}`);
  console.log(`ADB   : ${ADB}`);
  console.log(`Mode  : ${opts.noWindow ? "sans fenêtre" : "fenêtres visibles"}${opts.cold ? ", boot complet" : ", démarrage rapide (snapshot)"}`);

  const installedAvds = await listAvds();
  const missing = VMS.filter((vm) => !installedAvds.includes(vm.name));
  if (missing.length) {
    console.error(`ERREUR : AVD manquants : ${missing.map((m) => m.name).join(", ")}`);
    console.error("Créez-les : npm run android:provision -- --all");
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
      await adb(`emulator-${vm.port}`, ["emu", "kill"], 15000);
    }
  }
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
