/**
 * Test de bout en bout : un message entre par le pont, une réponse en sort.
 *
 * Rien n'est simulé côté extension — c'est le vrai `Agent`, le vrai
 * `BridgeTransport`, la vraie configuration. Seuls le canal et le modèle sont
 * remplacés par des serveurs HTTP locaux, exactement comme le seraient un pont
 * Snapchat et un llama-server.
 *
 *   node --test dist/e2e.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const home = mkdtempSync(join(tmpdir(), "snap-astreinte-e2e-"));
process.env.SNAP_ASTREINTE_HOME = home;

const { Agent } = await import("./agent.js");
const { Config } = await import("./config.js");
const { BridgeTransport } = await import("./transports/bridge.js");

process.on("exit", () => rmSync(home, { recursive: true, force: true }));

/** Pont factice : diffuse les messages qu'on lui pousse, collecte les envois. */
class FakeBridge {
  readonly sent: {
    contactId: string;
    text?: string;
    voice?: boolean;
    media?: { mimeType?: string; caption?: string };
  }[] = [];
  private clients: import("node:http").ServerResponse[] = [];
  private server: Server;
  port = 0;

  constructor(
    private voiceCapable = false,
    private imageCapable = false,
  ) {
    this.server = createServer((req, res) => {
      const url = req.url ?? "";

      if (url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            voice: this.voiceCapable,
            images: this.imageCapable,
            detail: "pont de test",
          }),
        );
        return;
      }

      if (url === "/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(": prêt\n\n");
        this.clients.push(res);
        req.on("close", () => {
          this.clients = this.clients.filter((c) => c !== res);
        });
        return;
      }

      if (url === "/send" || url === "/sendVoice" || url === "/sendMedia") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const parsed = JSON.parse(body || "{}") as {
            contactId: string;
            text?: string;
            mimeType?: string;
            caption?: string;
          };
          this.sent.push({
            contactId: parsed.contactId,
            text: parsed.text,
            voice: url === "/sendVoice",
            media:
              url === "/sendMedia"
                ? { mimeType: parsed.mimeType, caption: parsed.caption }
                : undefined,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
    return `http://127.0.0.1:${this.port}`;
  }

  /** Simule l'arrivée d'un message côté canal. */
  push(msg: Record<string, unknown>): void {
    const payload = `data: ${JSON.stringify(msg)}\n\n`;
    for (const c of this.clients) c.write(payload);
  }

  async close(): Promise<void> {
    for (const c of this.clients) c.end();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

/** Modèle factice : répond en reprenant le dernier message, pour tracer l'origine. */
class FakeLlm {
  readonly seen: { system: string; lastUser: string }[] = [];
  private server: Server;

  constructor(
    private delayMs = 0,
    private reply?: string,
  ) {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}") as {
          messages: { role: string; content: string }[];
        };
        const system = parsed.messages.find((m) => m.role === "system")?.content ?? "";
        const lastUser = [...parsed.messages].reverse().find((m) => m.role === "user")?.content ?? "";
        this.seen.push({ system, lastUser });

        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: this.reply ?? `réponse à « ${lastUser} »`,
                  },
                },
              ],
            }),
          );
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

const waitFor = async (fn: () => boolean, ms = 5000) => {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > ms) throw new Error("délai dépassé");
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("un message entrant produit une réponse sortante sur le même contact", async () => {
  const bridge = new FakeBridge();
  const llm = new FakeLlm();
  const bridgeUrl = await bridge.listen();
  const llmUrl = await llm.listen();

  const cfg = Config.load();
  cfg.update({
    "transport.driver": "bridge",
    "transport.bridge_url": bridgeUrl,
    "llm.base_url": llmUrl,
    "llm.model": "test",
    "llm.timeout_ms": 5000,
    "limits.enabled": true,
    "limits.active_hours": "",
    "limits.escalation_keywords": ["urgent"],
    "limits.max_turns_before_escalation": 0,
    "voice.tts_mode": "disabled",
    "voice.mode": "never",
    "persona.name": "Astreinte",
  });

  const transport = new BridgeTransport({ baseUrl: bridgeUrl });
  const agent = new Agent(cfg, transport);
  await transport.start((m) => agent.handle(m));

  bridge.push({ contactId: "u1", contactName: "Marc", text: "mon wifi coupe" });
  await waitFor(() => bridge.sent.length >= 1);

  assert.equal(bridge.sent[0]?.contactId, "u1");
  assert.match(bridge.sent[0]?.text ?? "", /mon wifi coupe/);
  // La persona configurée est bien arrivée jusqu'au modèle.
  assert.match(llm.seen[0]?.system ?? "", /Astreinte/);
  assert.match(llm.seen[0]?.system ?? "", /Marc/);

  await transport.stop();
  await bridge.close();
  await llm.close();
});

test("deux contacts servis en même temps reçoivent chacun SA réponse", async () => {
  const bridge = new FakeBridge();
  // Le modèle traîne : c'est là que deux conversations peuvent s'entrelacer.
  const llm = new FakeLlm(60);
  const bridgeUrl = await bridge.listen();
  const llmUrl = await llm.listen();

  const cfg = Config.load();
  cfg.update({
    "transport.driver": "bridge",
    "transport.bridge_url": bridgeUrl,
    "llm.base_url": llmUrl,
    "llm.timeout_ms": 5000,
    "limits.enabled": true,
    "limits.active_hours": "",
    "limits.max_turns_before_escalation": 0,
    "limits.escalation_keywords": [],
    "voice.tts_mode": "disabled",
    "voice.mode": "never",
  });

  const transport = new BridgeTransport({ baseUrl: bridgeUrl });
  const agent = new Agent(cfg, transport);
  await transport.start((m) => agent.handle(m));

  bridge.push({ contactId: "alice", contactName: "Alice", text: "imprimante hors ligne" });
  bridge.push({ contactId: "bob", contactName: "Bob", text: "écran bleu au démarrage" });

  await waitFor(() => bridge.sent.length >= 2, 8000);

  const toAlice = bridge.sent.find((s) => s.contactId === "alice");
  const toBob = bridge.sent.find((s) => s.contactId === "bob");

  assert.ok(toAlice, "Alice doit avoir reçu une réponse");
  assert.ok(toBob, "Bob doit avoir reçu une réponse");
  assert.match(toAlice!.text ?? "", /imprimante/, "Alice ne doit pas recevoir le sujet de Bob");
  assert.match(toBob!.text ?? "", /écran bleu/, "Bob ne doit pas recevoir le sujet d'Alice");

  // Et chacun garde son propre historique côté disque.
  const a = agent.store.read("alice");
  const b = agent.store.read("bob");
  assert.ok(a.turns.every((t) => !t.content.includes("écran bleu")));
  assert.ok(b.turns.every((t) => !t.content.includes("imprimante")));

  await transport.stop();
  await bridge.close();
  await llm.close();
});

test("un mot-clé d'escalade coupe court sans appeler le modèle", async () => {
  const bridge = new FakeBridge();
  const llm = new FakeLlm();
  const bridgeUrl = await bridge.listen();
  const llmUrl = await llm.listen();

  const cfg = Config.load();
  cfg.update({
    "transport.driver": "bridge",
    "transport.bridge_url": bridgeUrl,
    "llm.base_url": llmUrl,
    "llm.timeout_ms": 5000,
    "limits.enabled": true,
    "limits.active_hours": "",
    "limits.escalation_keywords": ["urgent"],
    "limits.escalation_message": "Je transmets, on te répond vite.",
    "voice.tts_mode": "disabled",
    "voice.mode": "never",
    "notify.enabled": false,
  });

  const transport = new BridgeTransport({ baseUrl: bridgeUrl });
  const agent = new Agent(cfg, transport);
  await transport.start((m) => agent.handle(m));

  bridge.push({ contactId: "carl", contactName: "Carl", text: "c'est urgent !" });
  await waitFor(() => bridge.sent.length >= 1);

  assert.equal(bridge.sent[0]?.text, "Je transmets, on te répond vite.");
  assert.equal(llm.seen.length, 0, "le modèle ne doit pas être appelé sur une escalade");
  assert.equal(agent.store.read("carl").escalated, true);

  // Le message suivant reste sans réponse tant qu'on n'a pas rendu la main.
  bridge.push({ contactId: "carl", text: "tu es là ?" });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(bridge.sent.length, 1, "aucune réponse après escalade");

  assert.equal(agent.resume("carl"), true);
  bridge.push({ contactId: "carl", text: "et maintenant ?" });
  await waitFor(() => bridge.sent.length >= 2);
  assert.match(bridge.sent[1]?.text ?? "", /et maintenant/);

  await transport.stop();
  await bridge.close();
  await llm.close();
});

test("le pont qui refuse le vocal fait retomber la réponse en texte", async () => {
  const bridge = new FakeBridge(false); // voice: false
  const llm = new FakeLlm();
  const bridgeUrl = await bridge.listen();
  const llmUrl = await llm.listen();

  const cfg = Config.load();
  cfg.update({
    "transport.driver": "bridge",
    "transport.bridge_url": bridgeUrl,
    "llm.base_url": llmUrl,
    "llm.timeout_ms": 5000,
    "limits.enabled": true,
    "limits.active_hours": "",
    "limits.escalation_keywords": [],
    "limits.max_turns_before_escalation": 0,
    "voice.mode": "always",
    "voice.tts_mode": "disabled",
  });

  const transport = new BridgeTransport({ baseUrl: bridgeUrl });
  const agent = new Agent(cfg, transport);
  await transport.start((m) => agent.handle(m));

  bridge.push({ contactId: "dana", text: "explique moi" });
  await waitFor(() => bridge.sent.length >= 1);

  assert.equal(bridge.sent[0]?.voice, false, "sans vocal disponible, la réponse part en texte");
  assert.match(bridge.sent[0]?.text ?? "", /explique moi/);

  await transport.stop();
  await bridge.close();
  await llm.close();
});

test("un modèle injoignable prévient la personne au lieu de l'ignorer", async () => {
  const bridge = new FakeBridge();
  const bridgeUrl = await bridge.listen();

  const cfg = Config.load();
  cfg.update({
    "transport.driver": "bridge",
    "transport.bridge_url": bridgeUrl,
    // Port fermé : aucune chance que ça réponde.
    "llm.base_url": "http://127.0.0.1:1/v1",
    "llm.timeout_ms": 2000,
    "limits.enabled": true,
    "limits.active_hours": "",
    "limits.escalation_keywords": [],
    "limits.max_turns_before_escalation": 0,
    "voice.tts_mode": "disabled",
    "voice.mode": "never",
    "notify.enabled": false,
  });

  const transport = new BridgeTransport({ baseUrl: bridgeUrl });
  const agent = new Agent(cfg, transport);
  await transport.start((m) => agent.handle(m));

  bridge.push({ contactId: "eve", text: "au secours" });
  await waitFor(() => bridge.sent.length >= 1, 8000);

  assert.match(bridge.sent[0]?.text ?? "", /je reviens vers toi/i);
  // L'agent pousse l'entrée de journal dans son `finally`, APRÈS la
  // résolution de l'envoi : attendre qu'elle existe, sinon la course
  // fait échouer le test sous charge.
  await waitFor(() => agent.recentLog().at(-1)?.error != null, 8000);
  assert.ok(agent.recentLog().at(-1)?.error, "l'échec doit être tracé dans le journal");

  await transport.stop();
  await bridge.close();
});

test("un pont qui accepte le vocal reçoit bien une note vocale synthétisée", async () => {
  // Le seul chemin encore non couvert : pont capable + TTS disponible.
  const bridge = new FakeBridge(true); // voice: true
  const llm = new FakeLlm();
  const bridgeUrl = await bridge.listen();
  const llmUrl = await llm.listen();

  // Faux serveur TTS : renvoie un WAV minimal mais valide.
  const wav = Buffer.concat([
    Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "),
    Buffer.alloc(4, 16), Buffer.alloc(16), Buffer.from("data"), Buffer.alloc(4),
    Buffer.alloc(256),
  ]);
  let ttsCalls = 0;
  const tts = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      ttsCalls += 1;
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(wav);
    });
  });
  await new Promise<void>((r) => tts.listen(0, "127.0.0.1", r));
  const ttsUrl = `http://127.0.0.1:${(tts.address() as AddressInfo).port}/v1/audio/speech`;

  const cfg = Config.load();
  cfg.update({
    "transport.driver": "bridge",
    "transport.bridge_url": bridgeUrl,
    "llm.base_url": llmUrl,
    "llm.timeout_ms": 5000,
    "limits.enabled": true,
    "limits.active_hours": "",
    "limits.escalation_keywords": [],
    "limits.max_turns_before_escalation": 0,
    "voice.mode": "always",
    "voice.tts_mode": "http",
    "voice.tts_url": ttsUrl,
    "voice.max_chars": 3000,
  });

  const transport = new BridgeTransport({ baseUrl: bridgeUrl });
  const agent = new Agent(cfg, transport);
  await transport.start((m) => agent.handle(m));

  bridge.push({ contactId: "zoe", contactName: "Zoé", text: "explique moi le wifi" });
  await waitFor(() => bridge.sent.length >= 1, 8000);

  assert.equal(ttsCalls, 1, "le TTS doit avoir été appelé");
  assert.equal(bridge.sent[0]?.voice, true, "la réponse doit partir en note vocale");
  assert.equal(bridge.sent[0]?.contactId, "zoe");

  await transport.stop();
  await bridge.close();
  await llm.close();
  await new Promise<void>((r) => tts.close(() => r()));
});

test("un pont qui accepte les images reçoit la photo générée, avec la légende", async () => {
  // Le flux image complet passe par le vrai contrat /sendMedia du pont.
  const bridge = new FakeBridge(false, true); // images: true
  // Le modèle émet la directive IMAGE: comme le lui demande le prompt système.
  const llm = new FakeLlm(0, "IMAGE: a red bicycle on a mountain road\nVoici l'image !");
  const bridgeUrl = await bridge.listen();
  const llmUrl = await llm.listen();

  // Faux serveur d'images : renvoie un b64_json.
  const png = Buffer.alloc(512);
  let imageCalls = 0;
  const images = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      imageCalls += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
    });
  });
  await new Promise<void>((r) => images.listen(0, "127.0.0.1", r));
  const imageUrl = `http://127.0.0.1:${(images.address() as AddressInfo).port}/v1`;

  const cfg = Config.load();
  cfg.update({
    "transport.driver": "bridge",
    "transport.bridge_url": bridgeUrl,
    "llm.base_url": llmUrl,
    "llm.timeout_ms": 5000,
    "image.mode": "on_request",
    "image.engine": "http",
    "image.base_url": imageUrl,
    "limits.enabled": true,
    "limits.active_hours": "",
    "limits.escalation_keywords": [],
    "limits.max_turns_before_escalation": 0,
    "voice.mode": "never",
    "voice.tts_mode": "disabled",
    "notify.enabled": false,
  });

  const transport = new BridgeTransport({ baseUrl: bridgeUrl });
  const agent = new Agent(cfg, transport);
  await transport.start((m) => agent.handle(m));

  bridge.push({ contactId: "yann", contactName: "Yann", text: "envoie-moi une photo de vélo" });
  await waitFor(() => bridge.sent.length >= 1, 8000);

  assert.equal(imageCalls, 1, "le serveur d'images doit avoir été appelé");
  assert.equal(bridge.sent[0]?.contactId, "yann");
  assert.equal(bridge.sent[0]?.voice, false);
  assert.ok(bridge.sent[0]?.media, "la réponse doit partir par /sendMedia");
  assert.equal(bridge.sent[0]?.media?.mimeType, "image/png");
  assert.equal(bridge.sent[0]?.media?.caption, "Voici l'image !");

  // Même course que pour le log d'erreur : l'entrée arrive après l'envoi.
  await waitFor(() => agent.recentLog().at(-1)?.image === true, 8000);
  const entry = agent.recentLog().at(-1);
  assert.equal(entry?.image, true, "le journal doit tracer l'envoi d'image");

  await transport.stop();
  await bridge.close();
  await llm.close();
  await new Promise<void>((r) => images.close(() => r()));
});
