/**
 * Adaptateur `SnapchatClient` → `Transport`.
 *
 * Ces tests prouvent que le démon autonome tourne par-dessus la couche client
 * du dépôt — donc sur Snapchat via adb — sans aucun pont HTTP intermédiaire.
 *
 *   node --test dist/client-adapter.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const home = mkdtempSync(join(tmpdir(), "snap-astreinte-adapter-"));
process.env.SNAP_ASTREINTE_HOME = home;

const { Agent } = await import("./agent.js");
const { Config } = await import("./config.js");
const { ClientTransport } = await import("./transports/client-adapter.js");
type SnapchatClient = import("./client/types.js").SnapchatClient;

process.on("exit", () => rmSync(home, { recursive: true, force: true }));

/** Modèle factice : reprend le dernier message, pour tracer l'origine. */
class FakeLlm {
  readonly seen: string[] = [];
  private server: Server;

  constructor(private delayMs = 0) {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}") as { messages: { role: string; content: string }[] };
        const last = [...parsed.messages].reverse().find((m) => m.role === "user")?.content ?? "";
        this.seen.push(last);
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: `réponse à « ${last} »` } }] }));
        }, this.delayMs);
      });
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }

  async close(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

/** Client de chat factice : on y injecte des messages entrants à la demande. */
class FakeChatClient {
  conversations: Record<string, unknown>[] = [];
  messages: Record<string, string>[] = [];
  readAcks: string[] = [];
  voiceSends: { conversationId: string; audioPath?: string }[] = [];
  private seq = 0;
  private clock = Date.now();

  private stamp(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  private ensure(id: string, name: string) {
    let c = this.conversations.find((x) => x.id === id);
    if (!c) {
      c = {
        id,
        type: "individual",
        displayName: name,
        participants: [id],
        lastActivity: this.stamp(),
        unreadCount: 0,
      };
      this.conversations.push(c);
    }
    return c as { id: string; lastActivity: string };
  }

  /** Simule un message reçu de l'interlocuteur. */
  incoming(id: string, name: string, text: string): void {
    const c = this.ensure(id, name);
    const ts = this.stamp();
    c.lastActivity = ts;
    this.messages.push({
      id: `in-${++this.seq}`,
      conversationId: id,
      senderId: id,
      type: "text",
      text,
      timestamp: ts,
      status: "delivered",
    });
  }

  /** Ce que l'assistant a envoyé. */
  outgoing(): Record<string, string>[] {
    return this.messages.filter((m) => m.senderId === "me");
  }

  async getConversations(limit = 20) {
    return this.conversations.slice(0, limit);
  }
  async getConversation(id: string) {
    return this.conversations.find((c) => c.id === id);
  }
  async getMessages(id: string, limit = 50) {
    return this.messages.filter((m) => m.conversationId === id).slice(-limit);
  }
  async sendMessage(p: { conversationId: string; text: string }) {
    const c = this.ensure(p.conversationId, p.conversationId);
    const ts = this.stamp();
    c.lastActivity = ts;
    const m = {
      id: `out-${++this.seq}`,
      conversationId: p.conversationId,
      senderId: "me",
      type: "text",
      text: p.text,
      timestamp: ts,
      status: "sent",
    };
    this.messages.push(m);
    return m;
  }
  async sendVoiceNote(p: { conversationId: string; audioPath?: string }) {
    this.voiceSends.push({ conversationId: p.conversationId, audioPath: p.audioPath });
    const c = this.ensure(p.conversationId, p.conversationId);
    const ts = this.stamp();
    c.lastActivity = ts;
    const m = {
      id: `voice-${++this.seq}`,
      conversationId: p.conversationId,
      senderId: "me",
      type: "audio",
      timestamp: ts,
      status: "sent",
    };
    this.messages.push(m);
    return m;
  }
  async sendSnap() {
    throw new Error("non utilisé");
  }
  async markAsRead(id: string) {
    this.readAcks.push(id);
  }
  async listFriends() {
    return [];
  }
  async getFriend() {
    throw new Error("non utilisé");
  }
  async startVoiceCall() {
    throw new Error("non utilisé");
  }
  async endVoiceCall() {
    throw new Error("non utilisé");
  }
  async getActiveCall() {
    return null;
  }
  async getCallStatus() {
    throw new Error("non utilisé");
  }
}

const asClient = (c: FakeChatClient) => c as unknown as SnapchatClient;

const waitFor = async (fn: () => boolean, ms = 8000) => {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > ms) throw new Error("délai dépassé");
    await new Promise((r) => setTimeout(r, 20));
  }
};

function baseConfig(llmUrl: string) {
  const cfg = Config.load();
  cfg.update({
    "llm.base_url": llmUrl,
    "llm.timeout_ms": 5000,
    "limits.enabled": true,
    "limits.active_hours": "",
    "limits.escalation_keywords": [],
    "limits.max_turns_before_escalation": 0,
    "voice.tts_mode": "disabled",
    "voice.mode": "never",
    "notify.enabled": false,
  });
  return cfg;
}

test("le démon autonome répond par-dessus le client, sans aucun pont HTTP", async () => {
  const client = new FakeChatClient();
  const llm = new FakeLlm();
  const cfg = baseConfig(await llm.listen());

  const transport = new ClientTransport({
    client: asClient(client),
    label: "fake",
    voice: false,
    pollIntervalMs: 50,
  });
  const agent = new Agent(cfg, transport);
  await transport.start((m) => agent.handle(m));

  client.incoming("marc", "Marc", "mon imprimante bourre");
  await waitFor(() => client.outgoing().length >= 1);

  const reply = client.outgoing()[0];
  assert.match(reply?.text ?? "", /imprimante/);
  assert.equal(reply?.conversationId, "marc");
  assert.ok(client.readAcks.includes("marc"), "la conversation doit être marquée comme lue");

  await transport.stop();
  await llm.close();
});

test("aucune salve de réponses sur l'historique au démarrage", async () => {
  const client = new FakeChatClient();
  const llm = new FakeLlm();
  const cfg = baseConfig(await llm.listen());

  // Trois conversations en cours AVANT le démarrage. Y répondre en rafale au
  // lancement du démon serait le pire premier contact possible.
  client.incoming("a", "A", "vieux message 1");
  client.incoming("b", "B", "vieux message 2");
  client.incoming("c", "C", "vieux message 3");

  const transport = new ClientTransport({
    client: asClient(client),
    label: "fake",
    voice: false,
    pollIntervalMs: 50,
  });
  const agent = new Agent(cfg, transport);
  await transport.start((m) => agent.handle(m));

  await new Promise((r) => setTimeout(r, 500));
  assert.equal(llm.seen.length, 0, "le backlog ne doit déclencher aucune réponse");
  assert.equal(client.outgoing().length, 0);

  // Un message postérieur au démarrage, lui, passe.
  client.incoming("a", "A", "et maintenant ça coupe");
  await waitFor(() => client.outgoing().length >= 1);

  await transport.stop();
  await llm.close();
});

test("l'assistant ne se répond jamais à lui-même", async () => {
  const client = new FakeChatClient();
  const llm = new FakeLlm();
  const cfg = baseConfig(await llm.listen());

  const transport = new ClientTransport({
    client: asClient(client),
    label: "fake",
    voice: false,
    pollIntervalMs: 30,
  });
  const agent = new Agent(cfg, transport);
  await transport.start((m) => agent.handle(m));

  client.incoming("zoe", "Zoé", "wifi lent");
  await waitFor(() => client.outgoing().length >= 1);

  // Plusieurs tours de relève passent : la réponse envoyée ne doit jamais
  // être reprise pour une demande entrante.
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(llm.seen.length, 1, `modèle appelé ${llm.seen.length} fois au lieu d'une`);
  assert.equal(client.outgoing().length, 1);

  await transport.stop();
  await llm.close();
});

test("deux conversations simultanées restent séparées", async () => {
  const client = new FakeChatClient();
  const llm = new FakeLlm(50);
  const cfg = baseConfig(await llm.listen());

  const transport = new ClientTransport({
    client: asClient(client),
    label: "fake",
    voice: false,
    pollIntervalMs: 30,
  });
  const agent = new Agent(cfg, transport);
  await transport.start((m) => agent.handle(m));

  client.incoming("alice", "Alice", "écran noir");
  client.incoming("bob", "Bob", "imprimante hors ligne");
  await waitFor(() => client.outgoing().length >= 2, 10000);

  const toAlice = client.outgoing().find((m) => m.conversationId === "alice");
  const toBob = client.outgoing().find((m) => m.conversationId === "bob");
  assert.match(toAlice?.text ?? "", /écran noir/);
  assert.match(toBob?.text ?? "", /imprimante/);

  await transport.stop();
  await llm.close();
});

test("la note vocale parvient au client sous forme de fichier, puis est nettoyée", async () => {
  const client = new FakeChatClient();
  const transport = new ClientTransport({
    client: asClient(client),
    label: "fake",
    voice: true,
    pollIntervalMs: 5000,
  });

  let seenPath: string | undefined;
  const original = client.sendVoiceNote.bind(client);
  client.sendVoiceNote = async (p: { conversationId: string; audioPath?: string }) => {
    // Le fichier doit exister AU MOMENT de l'appel, pas après.
    seenPath = p.audioPath;
    assert.ok(p.audioPath && existsSync(p.audioPath), "le fichier audio doit exister pendant l'envoi");
    return original(p);
  };

  await transport.sendVoice("marc", Buffer.alloc(512, 7), "audio/ogg");

  assert.equal(client.voiceSends.length, 1);
  assert.match(seenPath ?? "", /\.ogg$/, "l'extension doit refléter le type MIME");
  assert.ok(!existsSync(seenPath ?? ""), "le fichier temporaire doit être nettoyé après l'envoi");
});

test("un canal sans vocal refuse franchement plutôt que d'envoyer autre chose", async () => {
  const client = new FakeChatClient();
  const transport = new ClientTransport({
    client: asClient(client),
    label: "web",
    voice: false,
    pollIntervalMs: 5000,
  });

  await assert.rejects(
    () => transport.sendVoice("marc", Buffer.alloc(64), "audio/ogg"),
    /note vocale/,
  );
  assert.equal(client.voiceSends.length, 0);
});
