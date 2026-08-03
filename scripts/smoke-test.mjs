// SnapMCP smoke test — spawns the server and exercises MCP tools over stdio.
import { spawn } from "node:child_process";

const proc = spawn("node", ["dist/index.js"], {
  cwd: new URL("..", import.meta.url).pathname,
});

let buf = "";
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

setTimeout(() => proc.kill(), 4500);

setTimeout(() => {
  const lines = buf.split("\n").filter((l) => l.trim());
  console.log("RESPONSES:", lines.length);
  for (const l of lines) {
    try {
      const o = JSON.parse(l);
      if (o.id === 2) {
        console.log("TOOLS:", o.result.tools.map((t) => t.name).join(", "));
      } else if (o.id === 3) {
        console.log("VOICE_NOTE:", o.result?.content?.[0]?.text ?? JSON.stringify(o.error ?? o));
      } else if (o.id === 4) {
        console.log("MESSAGE:", o.result?.content?.[0]?.text ?? JSON.stringify(o.error ?? o));
      } else if (o.id === 5) {
        console.log("VOICE_CALL:", o.result?.content?.[0]?.text ?? JSON.stringify(o.error ?? o));
      }
    } catch {
      console.log("RAW:", l.slice(0, 200));
    }
  }
}, 4300);
