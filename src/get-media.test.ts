/**
 * Tests de la réception des médias : l'outil `get_media` télécharge le média
 * d'un message reçu et le renvoie en base64, prêt à afficher.
 *
 *   node --test dist/get-media.test.js
 *
 * Le serveur SnapMCP réel (dist/snapmcp.js) tourne avec le backend « mock »,
 * exactement comme dans le banc de test : les appels passent par le vrai
 * JSON-RPC, pas par des fakes du serveur.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("./snapmcp.js", import.meta.url));

/** Client JSON-RPC minimal sur stdio, comme le fait le banc de test. */
class McpClient {
  private child: ChildProcess;
  private buffer = "";
  private id = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor() {
    this.child = spawn(process.execPath, [ENTRY], {
      env: { ...process.env, SNAPCHAT_CLIENT: "mock", SNAPCHAT_HEADLESS: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (d: string) => this.consume(d));
  }

  private consume(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const p = this.pending.get(Number(msg.id));
      if (!p) continue;
      this.pending.delete(Number(msg.id));
      msg.error ? p.reject(new Error(msg.error.message ?? "Erreur JSON-RPC")) : p.resolve(msg.result);
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Délai dépassé pour ${method}.`));
      }, 15_000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  /** Notification sans réponse (pas d'id) : le serveur n'a pas de handler pour elle. */
  notify(method: string, params: unknown): void {
    this.child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async init(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2026-07-28",
      capabilities: {},
      clientInfo: { name: "get-media-test", version: "1.0" },
    });
    this.notify("notifications/initialized", {});
  }

  async tools(): Promise<string[]> {
    const r = (await this.request("tools/list", {})) as { tools?: Array<{ name: string }> };
    return (r.tools ?? []).map((t) => t.name);
  }

  async call(tool: string, args: Record<string, unknown>): Promise<{
    isError?: boolean;
    content?: Array<{ text?: string }>;
    structuredContent?: { media?: { mimeType?: string; base64?: string }; messages?: unknown[] };
  }> {
    return (await this.request("tools/call", { name: tool, arguments: args })) as Awaited<
      ReturnType<McpClient["call"]>
    >;
  }

  close(): void {
    this.child.kill();
  }
}

test("l'outil get_media télécharge le média d'un message reçu (mock)", async (t) => {
  const mcp = new McpClient();
  t.after(() => mcp.close());
  await mcp.init();

  const tools = await mcp.tools();
  assert.ok(tools.includes("get_media"), "get_media doit être exposé par le serveur");

  // La conversation conv_1 contient un message image (msg_3) côté mock.
  const messages = await mcp.call("get_messages", { conversationId: "conv_1", limit: 10 });
  const list = messages.structuredContent?.messages as Array<{ id: string; type: string }>;
  assert.ok(list?.some((m) => m.type === "image"), "get_messages doit remonter un message image");

  const result = await mcp.call("get_media", { conversationId: "conv_1", messageId: "msg_3" });
  assert.equal(result.isError, undefined);
  const media = result.structuredContent?.media;
  assert.ok(media, "get_media doit renvoyer structuredContent.media");
  assert.equal(media.mimeType, "image/png");
  const bytes = Buffer.from(media.base64 ?? "", "base64");
  assert.deepEqual(
    [...bytes.subarray(0, 4)],
    [0x89, 0x50, 0x4e, 0x47],
    "le base64 doit être un vrai PNG",
  );
});

test("get_media refuse proprement un message sans média", async (t) => {
  const mcp = new McpClient();
  t.after(() => mcp.close());
  await mcp.init();

  // msg_2 est un message texte dans conv_1.
  const result = await mcp.call("get_media", { conversationId: "conv_1", messageId: "msg_2" });
  assert.equal(result.isError, true, "un message sans média doit être une erreur d'outil");
  const text = result.content?.map((x) => x.text ?? "").join(" ") ?? "";
  assert.match(text, /Aucun média/);
});
