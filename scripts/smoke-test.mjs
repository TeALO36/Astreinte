// SnapMCP smoke test — spawns the server and exercises MCP tools over stdio.
// Exits non-zero if the expected tools/responses are missing, so it can gate CI.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = "dist/snapmcp.js";

if (!existsSync(new URL(`../${ENTRY}`, import.meta.url))) {
  console.error(`smoke-test : ${ENTRY} introuvable — lancez « npm run build » d'abord.`);
  process.exit(1);
}

const proc = spawn("node", [ENTRY], { cwd: ROOT });

proc.on("error", (e) => {
  console.error(`smoke-test : impossible de lancer le serveur — ${e.message}`);
  process.exit(1);
});

// Évite un EPIPE non géré si le serveur meurt avant les envois planifiés.
proc.stdin.on("error", () => {});

let buf = "";
let failures = 0;
proc.stdout.on("data", (d) => (buf += d.toString()));
proc.stderr.on("data", (d) => console.error("STDERR:", d.toString().slice(0, 200)));

const send = (obj) => proc.stdin.write(JSON.stringify(obj) + "\n");

const steps = [
  { id: 1, ms: 300, msg: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "smoke", version: "1.0" } } } },
  { id: 2, ms: 800, msg: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } },
  { id: 3, ms: 1500, msg: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "send_voice_note", arguments: { conversationId: "conv_1", text: "Salut ca va" } } } },
  { id: 4, ms: 2200, msg: { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "send_message", arguments: { conversationId: "conv_1", text: "test message" } } } },
  { id: 5, ms: 2900, msg: { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "voice_call", arguments: { conversationId: "conv_1" } } } },
];

for (const s of steps) {
  setTimeout(() => send(s.msg), s.ms);
}

const expectedTools = [
  "open_web_login", "web_session_status", "adb_login",
  "get_conversations", "get_conversation", "get_messages", "get_media", "mark_as_read",
  "send_message", "send_snap", "send_voice_note", "list_friends", "get_friend",
  "voice_call", "end_call", "call_status", "active_call",
];

const responses = new Map();

const check = (label, ok, detail) => {
  if (ok) {
    console.log(`OK ${label}`);
  } else {
    failures += 1;
    console.error(`ÉCHEC ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

setTimeout(() => {
  proc.kill();

  const lines = buf.split("\n").filter((l) => l.trim());
  console.log(`RESPONSES: ${lines.length}`);
  for (const l of lines) {
    try {
      const o = JSON.parse(l);
      responses.set(o.id, o);
      if (o.id === 2) console.log("TOOLS:", o.result?.tools?.map((t) => t.name).join(", ") ?? "aucun");
      else if (o.id === 3) console.log("VOICE_NOTE:", o.result?.content?.[0]?.text ?? JSON.stringify(o.error ?? o));
      else if (o.id === 4) console.log("MESSAGE:", o.result?.content?.[0]?.text ?? JSON.stringify(o.error ?? o));
      else if (o.id === 5) console.log("VOICE_CALL:", o.result?.content?.[0]?.text ?? JSON.stringify(o.error ?? o));
    } catch {
      // ligne non-JSON (par exemple des logs du serveur) : ignorée
    }
  }

  // ── Assertions ─────────────────────────────────────────────────────

  const r1 = responses.get(1);
  const r2 = responses.get(2);
  const r3 = responses.get(3);
  const r4 = responses.get(4);
  const r5 = responses.get(5);

  check("initialize", !!r1 && !r1.error && !!r1.result?.protocolVersion, r1?.error?.message ?? r1?.result?.protocolVersion ?? "pas de réponse");
  check(
    `tools/list (${expectedTools.length} tools)`,
    !!r2 && !r2.error && Array.isArray(r2.result?.tools) && r2.result.tools.length === expectedTools.length,
    `reçu ${r2?.result?.tools?.length ?? 0} tools`,
  );
  check(
    "tools/list contient tous les tools attendus",
    !!r2?.result?.tools && expectedTools.every((t) => r2.result.tools.some((x) => x.name === t)),
    "liste incomplète",
  );
  check("send_voice_note", !!r3 && !r3.error && /sent/i.test(r3.result?.content?.[0]?.text ?? ""), r3?.error?.message ?? "échec");
  check("send_message", !!r4 && !r4.error && /sent/i.test(r4.result?.content?.[0]?.text ?? ""), r4?.error?.message ?? "échec");
  check("voice_call", !!r5 && !r5.error && /initiated/i.test(r5.result?.content?.[0]?.text ?? ""), r5?.error?.message ?? "échec");

  console.log(failures === 0 ? "\nSmoke test réussi ✓" : `\n${failures} assertion(s) en échec ✗`);
  process.exit(failures === 0 ? 0 : 1);
}, 5000);

// Sécurité : si le serveur meurt avant la fin, on échoue aussi.
proc.on("exit", (code) => {
  if (code !== null && code !== 0 && responses.size === 0) {
    console.error(`smoke-test : le serveur s'est arrêté (code ${code}) sans répondre.`);
    process.exit(1);
  }
});
