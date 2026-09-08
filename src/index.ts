#!/usr/bin/env node
/**
 * Point d'entrée. Deux modes :
 *
 *   snap-astreinte daemon   le persona lui-même : reçoit, répond, envoie
 *   snap-astreinte mcp      serveur MCP de supervision, sur stdio
 *   snap-astreinte check    vérifie la configuration sans rien envoyer
 *
 * Les deux premiers peuvent tourner en même temps : ils partagent les fichiers
 * de contexte et de configuration.
 */

import { Agent } from "./agent.js";
import { Config, astreinteHome } from "./config.js";
import { loadDotEnv } from "./env.js";
import { runMcpServer } from "./mcp.js";
import { Llm } from "./llm.js";
import { Tts } from "./tts.js";
import { createTransport } from "./transports/index.js";
import { snapchatSetupHint } from "./transports/snapchat.js";
import { withinActiveHours } from "./policy.js";

/** Cadence de relance des messages mis en attente hors plage horaire. */
const FLUSH_INTERVAL_MS = 60_000;

loadDotEnv();

async function daemon(): Promise<void> {
  const cfg = Config.load();
  console.error(`[snap-astreinte] données : ${astreinteHome()}`);

  let transport;
  try {
    transport = await createTransport(cfg);
  } catch (e) {
    console.error(`[snap-astreinte] ${(e as Error).message}`);
    process.exit(1);
  }

  const agent = new Agent(cfg, transport);

  const purged = agent.store.purge(cfg.num("context.retention_days"));
  if (purged) console.error(`[snap-astreinte] ${purged} conversation(s) purgée(s) par ancienneté`);

  try {
    await transport.start((msg) => agent.handle(msg));
  } catch (e) {
    const message = (e as Error).message;
    if (cfg.str("transport.driver") === "snapchat") {
      console.error(snapchatSetupHint(cfg.str("transport.bridge_url")));
    } else {
      console.error(`[snap-astreinte] démarrage impossible : ${message}`);
    }
    process.exit(1);
  }

  console.error(
    `[snap-astreinte] persona actif — garde-fous ${cfg.bool("limits.enabled") ? "actifs" : "DÉSACTIVÉS"}` +
      `, voix ${cfg.str("voice.mode")}`,
  );

  const flush = setInterval(() => {
    if (!withinActiveHours(cfg.str("limits.active_hours"))) return;
    agent
      .flushPending()
      .then((n) => {
        if (n) console.error(`[snap-astreinte] ${n} message(s) en attente traité(s)`);
      })
      .catch((e) => console.error(`[snap-astreinte] reprise des messages en attente : ${e.message}`));
  }, FLUSH_INTERVAL_MS);

  const shutdown = async (signal: string) => {
    console.error(`[snap-astreinte] ${signal} — arrêt`);
    clearInterval(flush);
    await transport.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

/** Contrôle de configuration : dit ce qui marche et ce qui manque, sans rien envoyer. */
async function check(): Promise<void> {
  const cfg = Config.load();
  const lines: string[] = [`Données      : ${astreinteHome()}`];

  const driver = cfg.str("transport.driver");
  lines.push(`Canal        : ${driver}`);
  try {
    await createTransport(cfg);
    lines.push("  → configuration du canal acceptée");
  } catch (e) {
    lines.push(`  → PROBLÈME : ${(e as Error).message}`);
  }

  lines.push(`Garde-fous   : ${cfg.bool("limits.enabled") ? "actifs" : "DÉSACTIVÉS"}`);
  lines.push(`Plage        : ${cfg.str("limits.active_hours") || "toute heure"}`);

  const llm = new Llm({
    baseUrl: cfg.str("llm.base_url"),
    model: cfg.str("llm.model"),
    apiKey: cfg.str("llm.api_key") || undefined,
    timeoutMs: 20_000,
  });
  try {
    const reply = await llm.chat([{ role: "user", content: "Réponds exactement : OK" }], 12);
    lines.push(`Modèle       : joignable (${reply.slice(0, 40)})`);
  } catch (e) {
    lines.push(`Modèle       : PROBLÈME — ${(e as Error).message}`);
  }

  const tts = new Tts(cfg);
  if (!tts.available) {
    lines.push(`Voix         : indisponible (mode ${tts.mode})`);
  } else {
    try {
      const clip = await tts.synthesize("Test du persona.");
      lines.push(`Voix         : ${clip.audio.length} octets en ${clip.mimeType}`);
    } catch (e) {
      lines.push(`Voix         : PROBLÈME — ${(e as Error).message}`);
    }
  }

  console.log(lines.join("\n"));
}

const mode = process.argv[2] ?? "daemon";

switch (mode) {
  case "daemon":
  case "start":
    await daemon();
    break;
  case "mcp":
    await runMcpServer();
    break;
  case "check":
    await check();
    break;
  default:
    console.error(
      [
        "Astreinte — persona de messagerie",
        "",
        "  snap-astreinte daemon   reçoit et répond en continu",
        "  snap-astreinte mcp      serveur MCP de supervision (stdio)",
        "  snap-astreinte check    vérifie la configuration sans rien envoyer",
      ].join("\n"),
    );
    process.exit(1);
}
