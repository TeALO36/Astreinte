#!/usr/bin/env node
/**
 * Vérification sans tête du banc lui-même — aucun compte, aucun trafic réel.
 *
 * 1. démarre le vrai banc (`scripts/test-bench-app.mjs --no-open`) sur un port libre ;
 * 2. exige HTTP 200 et un marqueur de contenu réel sur l'accueil et sur /studio ;
 * 3. arrête le banc proprement : POST /api/shutdown (le même gestionnaire que
 *    Ctrl+C ; sur Windows, aucun signal inter-processus n'est délivrable) ;
 * 4. exige que le port soit libéré ensuite : aucun processus orphelin à l'écoute.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });

const fetchPage = async (url, timeoutMs = 5000) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return { status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
};

const waitReady = async (base, deadlineMs = 30000) => {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try {
      if ((await fetchPage(base + "/", 1500)).status === 200) return true;
    } catch {
      /* pas encore en écoute */
    }
    await sleep(400);
  }
  return false;
};

const isDead = (child) => child.exitCode !== null || child.signalCode !== null;

/** Arrêt propre : Windows n'offre aucun signal inter-processus délivrable
 * (SIGINT/SIGTERM = TerminateProcess ; CTRL_BREAK exige une console partagée
 * ou un groupe avec console). La voie déterministe est le POST /api/shutdown,
 * qui exécute exactement le même gestionnaire que Ctrl+C. SIGKILL en filet. */
const stopBench = async (child, base) => {
  if (!isDead(child)) {
    try {
      await fetch(base + "/api/shutdown", { method: "POST", signal: AbortSignal.timeout(3000) });
    } catch {
      /* déjà mort ou pas prêt */
    }
    const end = Date.now() + 8000;
    while (Date.now() < end && !isDead(child)) await sleep(150);
  }
  for (const sig of ["SIGINT", "SIGKILL"]) {
    if (isDead(child)) break;
    try {
      child.kill(sig);
    } catch {
      /* déjà mort */
    }
    const end = Date.now() + 3000;
    while (Date.now() < end && !isDead(child)) await sleep(150);
  }
  return isDead(child) ? (child.signalCode ?? `exit ${child.exitCode}`) : null;
};

const portFreed = async (base, deadlineMs = 10000) => {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try {
      await fetchPage(base + "/", 800);
    } catch {
      return true; // connexion refusée = plus personne à l'écoute
    }
    await sleep(300);
  }
  return false;
};

// --- scénario ------------------------------------------------------------

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const child = spawn(
  process.execPath,
  [join(ROOT, "scripts", "test-bench-app.mjs"), "--port", String(PORT), "--no-open"],
  {
    cwd: ROOT,
    env: { ...process.env, SNAPMCP_BENCH_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  },
);
let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));

const ready = await waitReady(BASE);
ok("démarrage du banc (sans tête)", ready, ready ? BASE : "readiness timeout");
if (!ready) {
  console.error("--- sortie du banc ---\n" + log.slice(-2500));
  await stopBench(child);
  process.exit(1);
}

const home = await fetchPage(BASE + "/");
ok("GET / → 200", home.status === 200, `HTTP ${home.status}, ${home.body.length} octets`);
ok("accueil : titre banc + lien Studio", home.body.includes("SnapMCP") && home.body.includes("Persona Studio"));

const studio = await fetchPage(BASE + "/studio");
ok("GET /studio → 200", studio.status === 200, `HTTP ${studio.status}, ${studio.body.length} octets`);
ok("studio : titre + volet Situation réelle", studio.body.includes("Persona Studio") && studio.body.includes("Situation réelle"));

const stopped = await stopBench(child, BASE);
const stopMode = process.platform === "win32" ? "POST /api/shutdown (= gestionnaire Ctrl+C)" : "SIGINT";
ok("arrêt du banc", stopped !== null, `${stopped} (${stopMode})`);

const freed = await portFreed(BASE);
ok("port libéré après arrêt", freed, `port ${PORT}`);
if (!freed) console.error("--- sortie du banc ---\n" + log.slice(-2500));

console.log(failures === 0 ? "\nBanc vérifié sans tête ✓" : `\n${failures} échec(s)`);
process.exit(failures === 0 ? 0 : 1);
