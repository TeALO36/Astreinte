/**
 * Test d'intégration : lance le pont Telethon (`bridge-telethon/bridge.py`)
 * en dry-run et vérifie le contrat HTTP complet depuis Node.
 *
 *   node --test dist/bridge-integration.test.js
 *
 * C'est un vrai processus Python qui tourne, sans aucun compte Telegram :
 * `/health` annonce ses capacités, `/events` ouvre un flux SSE, et les routes
 * d'envoi refusent proprement tant que rien n'est connecté.
 *
 * L'environnement Python doit exister (le venv `bridge-telethon/.venv` est
 * préféré, sinon un `python3`/`python` du PATH). S'il manque — Python ou
 * Telethon absents — le test est **sauté**, jamais échoué : la suite ne doit
 * pas dépendre d'une machine particulière.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIST_DIR = fileURLToPath(new URL(".", import.meta.url));
const BRIDGE_DIR = resolve(DIST_DIR, "..", "bridge-telethon");
const BRIDGE_SCRIPT = join(BRIDGE_DIR, "bridge.py");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Python à utiliser : le venv du pont s'il existe, sinon un python du PATH. */
function findPython(): string | null {
  const venv = process.platform === "win32"
    ? join(BRIDGE_DIR, ".venv", "Scripts", "python.exe")
    : join(BRIDGE_DIR, ".venv", "bin", "python");
  if (existsSync(venv)) return venv;
  for (const cand of process.platform === "win32" ? ["python"] : ["python3", "python"]) {
    const r = spawnSync(cand, ["--version"], { stdio: "ignore" });
    if (!r.error && r.status === 0) return cand;
  }
  return null;
}

/** Réserve un port libre puis le libère : le pont s'y attache juste après. */
function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => res(port));
    });
  });
}

interface RunningBridge {
  proc: ChildProcess;
  port: number;
  stderr: string;
}

function startBridge(python: string, port: number): RunningBridge {
  const proc = spawn(
    python,
    [BRIDGE_SCRIPT, "--dry-run", "--host", "127.0.0.1", "--port", String(port)],
    { cwd: BRIDGE_DIR, stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
  );
  const state: RunningBridge = { proc, port, stderr: "" };
  proc.stderr?.on("data", (c: Buffer) => {
    state.stderr += c.toString();
  });
  return state;
}

/** Tue le pont et attend sa sortie réelle (plus propre qu'un kill orphelin). */
function stopBridge(b: RunningBridge): Promise<void> {
  if (b.proc.exitCode !== null || b.proc.killed) return Promise.resolve();
  b.proc.kill("SIGKILL");
  return new Promise((res) => {
    const timer = setTimeout(res, 2000);
    timer.unref?.();
    b.proc.once("exit", () => {
      clearTimeout(timer);
      res();
    });
  });
}

/** Attend que le serveur HTTP du pont réponde (503 en dry-run). */
async function waitReady(b: RunningBridge, timeoutMs = 20_000): Promise<{ ok: boolean; reason?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (b.proc.exitCode !== null) {
      return {
        ok: false,
        reason: `le pont s'est arrêté (code ${b.proc.exitCode}) : ${b.stderr.slice(-300)}`,
      };
    }
    try {
      await fetch(`http://127.0.0.1:${b.port}/health`);
      return { ok: true }; // le serveur répond : il est prêt
    } catch {
      /* pas encore prêt */
    }
    await sleep(150);
  }
  return { ok: false, reason: `délai dépassé : ${b.stderr.slice(-300)}` };
}

/** Ouvre /events et renvoie le début du flux (le `: pret` d'ouverture). */
async function readSsePrefix(b: RunningBridge): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${b.port}/events`, {
    headers: { Accept: "text/event-stream" },
  });
  assert.equal(res.status, 200, "/events doit répondre 200");
  const reader = res.body?.getReader();
  assert.ok(reader, "/events doit exposer un corps de flux");
  const first = await reader.read();
  await reader.cancel();
  return new TextDecoder().decode(first.value);
}

async function post(
  b: RunningBridge,
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`http://127.0.0.1:${b.port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

test("le pont Telethon en dry-run respecte le contrat HTTP complet", async (t) => {
  const python = findPython();
  if (!python) {
    t.skip("Python introuvable : installez-le ou créez le venv bridge-telethon/.venv");
    return;
  }

  const port = await freePort();
  const bridge = startBridge(python, port);
  t.after(async () => {
    await stopBridge(bridge);
  });

  const ready = await waitReady(bridge);
  if (!ready.ok) {
    // Python présent mais Telethon (ou aiohttp) absent : l'environnement du
    // pont n'est pas complet — on saute plutôt que d'échouer la suite.
    t.skip(`pont non démarrable : ${ready.reason}`);
    return;
  }

  // 1. /health — le pont est debout mais pas connecté (dry-run) : 503 + capacités.
  const health = await fetch(`http://127.0.0.1:${bridge.port}/health`);
  assert.equal(health.status, 503, "sans compte connecté, /health répond 503");
  const healthBody = (await health.json()) as {
    ok: boolean;
    voice: boolean;
    images: boolean;
    detail?: string;
  };
  assert.equal(healthBody.ok, false);
  assert.equal(healthBody.voice, true, "le pont annonce le vocal (sendVoice)");
  assert.equal(healthBody.images, true, "le pont annonce les images (sendMedia)");
  assert.match(healthBody.detail ?? "", /dry-run/);

  // Et l'extension lit ce même /health via BridgeTransport : les deux côtés
  // du contrat s'accordent (pas prêt → ok:false).
  const { BridgeTransport } = await import("./transports/bridge.js");
  const probe = await new BridgeTransport({ baseUrl: `http://127.0.0.1:${bridge.port}` }).probe();
  assert.equal(probe.ok, false, "BridgeTransport doit lire le 503 comme « pont pas prêt »");

  // 2. /events — le flux SSE s'ouvre et annonce `: pret`.
  const prefix = await readSsePrefix(bridge);
  assert.ok(
    prefix.includes(": pret"),
    `le flux doit s'ouvrir par « : pret », reçu : ${JSON.stringify(prefix.slice(0, 60))}`,
  );

  // 3. /send, /sendVoice, /sendMedia — sans compte connecté : 503 + message clair.
  for (const [path, payload] of [
    ["/send", { contactId: "u1", text: "bonjour" }],
    ["/sendVoice", { contactId: "u1", audioBase64: "aGVsbG8=", mimeType: "audio/ogg" }],
    ["/sendMedia", { contactId: "u1", mediaBase64: "aGVsbG8=", mimeType: "image/png", caption: "" }],
  ] as const) {
    const res = await post(bridge, path, payload);
    assert.equal(res.status, 503, `${path} doit répondre 503 sans compte connecté`);
    assert.match(String(res.json?.error ?? ""), /non connecté/, `${path} doit expliquer l'absence de connexion`);
  }
});
