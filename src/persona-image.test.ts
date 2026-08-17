/**
 * Tests du flux « images » du persona.
 *
 *   node --test dist/persona-image.test.js
 *
 * Le vrai `Agent` tourne avec un canal factice qui enregistre les envois, un
 * faux modèle (qui émet la directive IMAGE:) et un faux serveur d'images
 * local — exactement comme le seraient un llama-server et un serveur
 * Stable Diffusion.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const home = mkdtempSync(join(tmpdir(), "snap-astreinte-image-test-"));
process.env.SNAP_ASTREINTE_HOME = home;

import type { IncomingMessage } from "./types.js";
import type { Transport } from "./transports/types.js";

const { Agent } = await import("./agent.js");
const { Config } = await import("./config.js");
const { asksForImage, extractImageRequest } = await import("./image.js");

process.on("exit", () => rmSync(home, { recursive: true, force: true }));

/** Canal factice : enregistre tout ce qu'on lui demande d'envoyer. */
class RecordingTransport implements Transport {
  readonly id = "rec";
  capabilities = { voice: false, images: true, typing: false };
  private handler: ((m: IncomingMessage) => Promise<void>) | null = null;
  sentText: string[] = [];
  sentImages: {
    contactId: string;
    media: Buffer | string;
    mimeType: string;
    caption?: string;
  }[] = [];

  async start(handler: (m: IncomingMessage) => Promise<void>): Promise<void> {
    this.handler = handler;
  }

  async stop(): Promise<void> {
    this.handler = null;
  }

  push(m: IncomingMessage): Promise<void> {
    return this.handler ? this.handler(m) : Promise.resolve();
  }

  async sendText(contactId: string, text: string): Promise<void> {
    this.sentText.push(text);
  }

  async sendVoice(): Promise<void> {
    throw new Error("canal sans vocal");
  }

  async sendImage(
    contactId: string,
    media: Buffer | string,
    mimeType: string,
    caption?: string,
  ): Promise<void> {
    this.sentImages.push({ contactId, media, mimeType, caption });
  }
}

/** Faux modèle : répond avec la directive IMAGE: et une légende. */
class FakeLlm {
  private server: Server;
  constructor(
    private reply = "IMAGE: a cute cat playing the piano\nVoici l'image.",
  ) {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: this.reply } }],
          }),
        );
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

/** Faux serveur d'images : renvoie un b64_json, ou une erreur sur demande. */
class FakeImageServer {
  private server: Server;
  calls = 0;
  constructor(private fail = false) {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        this.calls += 1;
        if (this.fail) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "moteur d'image indisponible" }));
          return;
        }
        const png = Buffer.alloc(512); // contenu factice, seule la taille compte ici
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }),
        );
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

function cfgWith(llmUrl: string, imageUrl: string) {
  const cfg = Config.load();
  cfg.update({
    "llm.base_url": llmUrl,
    "llm.model": "test",
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
  return cfg;
}

// ---------------------------------------------------------------------------
// Détection et extraction
// ---------------------------------------------------------------------------

test("asksForImage : reconnaît une demande, ignore une simple mention", () => {
  const positives = [
    "envoie-moi une photo de chat",
    "tu peux générer une image de coucher de soleil ?",
    "dessine-moi un logo pour mon entreprise",
    "je voudrais une illustration pour mon site",
    "montre-moi un portrait de chevalier",
    "can you generate an image of a castle",
    "send me a picture of the Eiffel Tower please",
  ];
  for (const p of positives) {
    assert.equal(asksForImage(p), true, `devrait détecter : ${p}`);
  }

  const negatives = [
    "mon écran affiche une image floue",
    "comment recadrer une photo",
    "le logo de l'entreprise n'apparaît pas",
    "j'ai un problème avec l'illustration du site",
    "what is the weather today",
    "mon imprimante est en panne",
  ];
  for (const n of negatives) {
    assert.equal(asksForImage(n), false, `ne devrait pas détecter : ${n}`);
  }
});

test("extractImageRequest : lit le marqueur IMAGE: et le texte qui suit", () => {
  const r = extractImageRequest(
    "IMAGE: a red bicycle on a mountain road\nVoici l'image demandée !",
  );
  assert.deepEqual(r, {
    prompt: "a red bicycle on a mountain road",
    textAfter: "Voici l'image demandée !",
  });

  // Sans marqueur, ou avec un prompt déraisonnable, rien n'est extrait.
  assert.equal(extractImageRequest("bonjour, pas d'image ici"), null);
  assert.equal(
    extractImageRequest(`IMAGE: ${"x".repeat(2000)}\ntexte`),
    null,
    "un « prompt » de 2000 caractères n'est pas un prompt",
  );
});

// ---------------------------------------------------------------------------
// De bout en bout
// ---------------------------------------------------------------------------

test("une demande d'image aboutit à l'envoi d'une photo avec légende", async () => {
  const llm = new FakeLlm();
  const images = new FakeImageServer();
  const llmUrl = await llm.listen();
  const imageUrl = await images.listen();

  const cfg = cfgWith(llmUrl, imageUrl);
  const transport = new RecordingTransport();
  const agent = new Agent(cfg, transport);
  await transport.start((m) => agent.handle(m));

  await transport.push({
    contactId: "u1",
    contactName: "Marc",
    text: "envoie-moi une image de chat",
    receivedAt: Date.now(),
  });

  // L'envoi est synchrone dans ce harnais : on peut vérifier immédiatement.
  assert.equal(images.calls, 1, "le serveur d'images doit avoir été appelé");
  assert.equal(transport.sentImages.length, 1);
  assert.equal(transport.sentImages[0]?.contactId, "u1");
  assert.equal(transport.sentImages[0]?.mimeType, "image/png");
  assert.equal(transport.sentImages[0]?.caption, "Voici l'image.");
  assert.equal(transport.sentText.length, 0, "aucun texte à part la légende");

  const entry = agent.recentLog().at(-1);
  assert.equal(entry?.image, true, "le journal doit tracer l'envoi d'image");

  await transport.stop();
  await llm.close();
  await images.close();
});

test("une image impossible retombe sur la légende en texte", async () => {
  const llm = new FakeLlm();
  const images = new FakeImageServer(true); // 500
  const llmUrl = await llm.listen();
  const imageUrl = await images.listen();

  const cfg = cfgWith(llmUrl, imageUrl);
  const transport = new RecordingTransport();
  const agent = new Agent(cfg, transport);
  await transport.start((m) => agent.handle(m));

  await transport.push({
    contactId: "u2",
    text: "fais une illustration de la tour Eiffel",
    receivedAt: Date.now(),
  });

  assert.equal(images.calls, 1);
  assert.equal(transport.sentImages.length, 0, "aucune image envoyée");
  assert.equal(transport.sentText.length, 1, "la légende part en texte");
  assert.equal(transport.sentText[0], "Voici l'image.");

  const entry = agent.recentLog().at(-1);
  assert.match(entry?.reason ?? "", /image indisponible/);

  await transport.stop();
  await llm.close();
  await images.close();
});

test("sans demande d'image, la réponse part en texte normal", async () => {
  const llm = new FakeLlm(); // répondrait avec un marqueur, mais jamais sollicité
  const images = new FakeImageServer();
  const llmUrl = await llm.listen();
  const imageUrl = await images.listen();

  const cfg = cfgWith(llmUrl, imageUrl);
  const transport = new RecordingTransport();
  const agent = new Agent(cfg, transport);
  await transport.start((m) => agent.handle(m));

  await transport.push({
    contactId: "u3",
    text: "mon wifi coupe",
    receivedAt: Date.now(),
  });

  assert.equal(images.calls, 0, "le moteur d'images ne doit pas être appelé");
  assert.equal(transport.sentImages.length, 0);
  // La réponse du modèle (avec le marqueur, qu'il ne devrait pas émettre ici)
  // part telle quelle en texte.
  assert.equal(transport.sentText.length, 1);

  await transport.stop();
  await llm.close();
  await images.close();
});
