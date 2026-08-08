/**
 * Tests. Le gros morceau est l'isolation des contextes : c'est la garantie sur
 * laquelle repose tout le reste, et la seule qui casse de façon silencieuse.
 *
 *   node --test dist/astreinte.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Doit être posé avant le premier import qui lit la configuration.
const home = mkdtempSync(join(tmpdir(), "snap-astreinte-test-"));
process.env.SNAP_ASTREINTE_HOME = home;

const { ContactStore } = await import("./store.js");
const { Policy, withinActiveHours } = await import("./policy.js");
const { Config } = await import("./config.js");
const { asksForVoice, splitCommand } = await import("./tts.js");
const { chunkText } = await import("./transports/telegram.js");
const { resolveTelegramSession, loadSessionString } = await import("./telegram/session.js");

process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Isolation des contextes
// ---------------------------------------------------------------------------

test("deux interlocuteurs simultanés ne se mélangent jamais", async () => {
  const store = new ContactStore(50);

  // Deux « conversations » entrelacées volontairement : chacune s'endort au
  // milieu de son traitement, exactement là où un appel au modèle le ferait.
  const alice = (async () => {
    for (let i = 0; i < 5; i++) {
      await store.withContact("alice", "Alice", async (ctx) => {
        store.addTurn(ctx, "user", `alice-${i}`);
        await sleep(3);
        store.addTurn(ctx, "assistant", `réponse-alice-${i}`);
      });
    }
  })();

  const bob = (async () => {
    for (let i = 0; i < 5; i++) {
      await store.withContact("bob", "Bob", async (ctx) => {
        store.addTurn(ctx, "user", `bob-${i}`);
        await sleep(2);
        store.addTurn(ctx, "assistant", `réponse-bob-${i}`);
      });
    }
  })();

  await Promise.all([alice, bob]);

  const a = store.read("alice");
  const b = store.read("bob");

  assert.equal(a.turns.length, 10);
  assert.equal(b.turns.length, 10);
  assert.ok(
    a.turns.every((t) => t.content.includes("alice")),
    `contamination dans le contexte d'Alice : ${JSON.stringify(a.turns.map((t) => t.content))}`,
  );
  assert.ok(
    b.turns.every((t) => t.content.includes("bob")),
    `contamination dans le contexte de Bob : ${JSON.stringify(b.turns.map((t) => t.content))}`,
  );
  assert.equal(a.turnCount, 5);
  assert.equal(b.turnCount, 5);
});

test("deux messages rapprochés du même contact sont sérialisés, aucun tour perdu", async () => {
  const store = new ContactStore(50);
  const order: string[] = [];

  // Sans verrou, les deux liraient le contexte avant que l'un ait écrit :
  // le premier tour serait écrasé.
  await Promise.all([
    store.withContact("carl", "Carl", async (ctx) => {
      order.push("début-1");
      await sleep(10);
      store.addTurn(ctx, "user", "premier");
      order.push("fin-1");
    }),
    store.withContact("carl", "Carl", async (ctx) => {
      order.push("début-2");
      await sleep(1);
      store.addTurn(ctx, "user", "second");
      order.push("fin-2");
    }),
  ]);

  const ctx = store.read("carl");
  assert.deepEqual(
    ctx.turns.map((t) => t.content),
    ["premier", "second"],
  );
  assert.deepEqual(order, ["début-1", "fin-1", "début-2", "fin-2"]);
});

test("un traitement qui échoue ne bloque pas la file du contact", async () => {
  const store = new ContactStore(50);

  await assert.rejects(
    store.withContact("dana", "Dana", async () => {
      throw new Error("modèle injoignable");
    }),
  );

  // Le message suivant doit passer malgré l'échec précédent.
  await store.withContact("dana", "Dana", (ctx) => {
    store.addTurn(ctx, "user", "après l'erreur");
  });

  assert.equal(store.read("dana").turns.length, 1);
});

test("les tours anciens sont repliés dans un résumé plutôt que jetés", async () => {
  const store = new ContactStore(4);
  await store.withContact("eve", "Eve", (ctx) => {
    for (let i = 0; i < 10; i++) store.addTurn(ctx, "user", `message ${i}`);
  });
  const ctx = store.read("eve");
  assert.equal(ctx.turns.length, 4);
  assert.ok(ctx.summary, "les tours débordants doivent laisser un résumé");
  assert.ok(ctx.summary!.includes("message 0"), "le plus ancien doit figurer dans le résumé");
  assert.equal(ctx.turns[0]?.content, "message 6");
});

test("oublier un contact n'affecte pas les autres", async () => {
  const store = new ContactStore(10);
  await store.withContact("f1", "F1", (ctx) => store.addTurn(ctx, "user", "a"));
  await store.withContact("f2", "F2", (ctx) => store.addTurn(ctx, "user", "b"));

  assert.equal(store.forget("f1"), true);
  assert.equal(store.forget("f1"), false);
  assert.equal(store.read("f2").turns.length, 1);
});

test("un identifiant exotique reste utilisable comme clé", async () => {
  const store = new ContactStore(10);
  const weird = "utilisateur/../avec espaces et accents éàü:*?";
  await store.withContact(weird, "Zoé", (ctx) => store.addTurn(ctx, "user", "salut"));
  assert.equal(store.read(weird).turns.length, 1);
  assert.ok(store.list().some((c) => c.contactId === weird));
});

// ---------------------------------------------------------------------------
// Garde-fous
// ---------------------------------------------------------------------------

function policyWith(overrides: Record<string, unknown>) {
  const cfg = Config.load();
  cfg.update({
    "limits.enabled": true,
    "limits.max_turns_before_escalation": 3,
    "limits.escalation_keywords": ["urgent", "données perdues"],
    "limits.escalation_message": "Je transmets.",
    "limits.active_hours": "",
    "limits.max_reply_chars": 100,
    ...overrides,
  });
  return { cfg, policy: new Policy(cfg) };
}

function ctxWith(turnCount: number, escalated = false) {
  return {
    contactId: "x",
    turns: [],
    turnCount,
    escalated,
    firstSeenAt: 0,
    lastSeenAt: 0,
  };
}

test("un mot-clé déclenche l'escalade, accents et casse compris", () => {
  const { policy } = policyWith({});
  const v = policy.evaluate(ctxWith(0), "c'est URGENT là");
  assert.equal(v.action, "escalate");

  const w = policy.evaluate(ctxWith(0), "j'ai des donnees perdues");
  assert.equal(w.action, "escalate", "la comparaison doit ignorer les accents");
});

test("le nombre de tours finit par déclencher l'escalade", () => {
  const { policy } = policyWith({});
  assert.equal(policy.evaluate(ctxWith(2), "ça marche pas").action, "reply");
  assert.equal(policy.evaluate(ctxWith(3), "ça marche toujours pas").action, "escalate");
});

test("une conversation escaladée reste silencieuse", () => {
  const { policy } = policyWith({});
  const v = policy.evaluate(ctxWith(0, true), "tu es là ?");
  assert.equal(v.action, "silent");
});

test("garde-fous décochés : plus aucune limite ne s'applique", () => {
  const { policy } = policyWith({ "limits.enabled": false });
  assert.equal(policy.evaluate(ctxWith(99), "URGENT données perdues").action, "reply");
  const long = "x".repeat(5000);
  assert.equal(policy.clamp(long), long, "aucune troncature en mode sans limite");
  assert.equal(policy.promptFragment(), "");
});

test("une réponse trop longue est coupée proprement et le signale", () => {
  // 200 est le minimum accepté par le schéma : une valeur plus basse serait
  // remontée à 200 par la coercition, et le test ne testerait rien.
  const { policy } = policyWith({ "limits.max_reply_chars": 200 });
  const source = "Première phrase de test. ".repeat(40); // 1000 caractères
  const out = policy.clamp(source);

  assert.ok(out.length < 300, `attendu court, obtenu ${out.length}`);
  assert.ok(out.includes("détaille"), "l'utilisateur doit savoir que c'est tronqué");
  // Coupé sur une frontière de phrase, pas au milieu d'un mot.
  const body = out.split("…")[0] ?? "";
  assert.ok(source.startsWith(body), "le début doit être conservé tel quel");
  assert.ok(!/\bPremièr$|\bphras$/.test(body.trimEnd()), "pas de mot tronqué");
});

test("plage horaire, y compris celles qui passent minuit", () => {
  const at = (h: number, m = 0) => new Date(2026, 0, 1, h, m);
  assert.equal(withinActiveHours("", at(3)), true, "vide = toujours actif");
  assert.equal(withinActiveHours("08:00-22:00", at(12)), true);
  assert.equal(withinActiveHours("08:00-22:00", at(23)), false);
  assert.equal(withinActiveHours("22:00-06:00", at(23)), true);
  assert.equal(withinActiveHours("22:00-06:00", at(3)), true);
  assert.equal(withinActiveHours("22:00-06:00", at(12)), false);
  assert.equal(withinActiveHours("n'importe quoi", at(12)), true, "une plage illisible ne rend pas muet");
});

test("hors plage, le message est différé", () => {
  const { policy } = policyWith({ "limits.active_hours": "00:00-00:01" });
  const v = policy.evaluate(ctxWith(0), "bonjour");
  // Sauf à tomber pile dans la minute, on doit être hors plage.
  if (new Date().getHours() !== 0 || new Date().getMinutes() !== 0) {
    assert.equal(v.action, "defer");
  }
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test("les valeurs sont contraintes au type et aux bornes du schéma", () => {
  const cfg = Config.load();
  cfg.update({
    "limits.max_reply_chars": "99999",
    "limits.enabled": "true",
    "limits.escalation_keywords": "un, deux\ntrois",
    "persona.language": "klingon",
  });
  assert.equal(cfg.num("limits.max_reply_chars"), 4000, "borné au maximum du schéma");
  assert.equal(cfg.bool("limits.enabled"), true, "la chaîne « true » devient un booléen");
  assert.deepEqual(cfg.list("limits.escalation_keywords"), ["un", "deux", "trois"]);
  assert.equal(cfg.get("persona.language"), "auto", "une valeur hors liste retombe sur le défaut");
});

test("une clé inconnue est refusée et signalée", () => {
  const cfg = Config.load();
  const { unknownKeys } = cfg.update({ "nimporte.quoi": 1, "persona.name": "Astreinte" });
  assert.deepEqual(unknownKeys, ["nimporte.quoi"]);
  assert.equal(cfg.str("persona.name"), "Astreinte");
});

test("la configuration survit à un rechargement", () => {
  const first = Config.load();
  first.update({ "persona.name": "Permanence" });
  const second = Config.load();
  assert.equal(second.str("persona.name"), "Permanence");
});

// ---------------------------------------------------------------------------
// Voix et découpage
// ---------------------------------------------------------------------------

test("la demande de vocal est détectée sans être trop gourmande", () => {
  assert.equal(asksForVoice("tu peux m'envoyer un vocal ?"), true);
  assert.equal(asksForVoice("Explique moi ça en audio stp"), true);
  assert.equal(asksForVoice("envoie un voice note"), true);
  assert.equal(asksForVoice("mon micro ne marche plus"), false);
  assert.equal(asksForVoice("le son de mon PC est coupé"), false);
  assert.equal(asksForVoice("j'ai un problème de carte audio interne"), false);
});

test("une ligne de commande TTS est découpée en respectant les guillemets", () => {
  assert.deepEqual(splitCommand('piper --model "C:/mes voix/fr.onnx" --out a.wav'), [
    "piper",
    "--model",
    "C:/mes voix/fr.onnx",
    "--out",
    "a.wav",
  ]);
});

test("un message trop long est découpé sans couper un mot", () => {
  const long = `${"Phrase de test. ".repeat(600)}`;
  const parts = chunkText(long, 4000);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 4000));
  assert.equal(parts.join(" ").replace(/\s+/g, " ").trim(), long.replace(/\s+/g, " ").trim());
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Session Telegram : précédence config > env SNAP_ASTREINTE_ > env TELEGRAM_
// ---------------------------------------------------------------------------

test("resolveTelegramSession : la config prime sur l'environnement", () => {
  const oldId = process.env.SNAP_ASTREINTE_TELEGRAM_API_ID;
  const oldHash = process.env.SNAP_ASTREINTE_TELEGRAM_API_HASH;
  process.env.SNAP_ASTREINTE_TELEGRAM_API_ID = "999";
  process.env.SNAP_ASTREINTE_TELEGRAM_API_HASH = "hash-env";
  try {
    const r = resolveTelegramSession({ apiId: "123", apiHash: "hash-config" });
    assert.equal(r.apiId, 123);
    assert.equal(r.apiHash, "hash-config");
  } finally {
    if (oldId === undefined) delete process.env.SNAP_ASTREINTE_TELEGRAM_API_ID;
    else process.env.SNAP_ASTREINTE_TELEGRAM_API_ID = oldId;
    if (oldHash === undefined) delete process.env.SNAP_ASTREINTE_TELEGRAM_API_HASH;
    else process.env.SNAP_ASTREINTE_TELEGRAM_API_HASH = oldHash;
  }
});

test("resolveTelegramSession : fallback SNAP_ASTREINTE_TELEGRAM_* quand pas de config", () => {
  const oldTgId = process.env.TELEGRAM_API_ID;
  const oldTgHash = process.env.TELEGRAM_API_HASH;
  const oldId = process.env.SNAP_ASTREINTE_TELEGRAM_API_ID;
  const oldHash = process.env.SNAP_ASTREINTE_TELEGRAM_API_HASH;
  delete process.env.TELEGRAM_API_ID;
  delete process.env.TELEGRAM_API_HASH;
  process.env.SNAP_ASTREINTE_TELEGRAM_API_ID = "456";
  process.env.SNAP_ASTREINTE_TELEGRAM_API_HASH = "hash-snap";
  try {
    const r = resolveTelegramSession({});
    assert.equal(r.apiId, 456);
    assert.equal(r.apiHash, "hash-snap");
    assert.equal(r.sessionFile, ".telegram/session.txt");
  } finally {
    if (oldTgId === undefined) delete process.env.TELEGRAM_API_ID;
    else process.env.TELEGRAM_API_ID = oldTgId;
    if (oldTgHash === undefined) delete process.env.TELEGRAM_API_HASH;
    else process.env.TELEGRAM_API_HASH = oldTgHash;
    if (oldId === undefined) delete process.env.SNAP_ASTREINTE_TELEGRAM_API_ID;
    else process.env.SNAP_ASTREINTE_TELEGRAM_API_ID = oldId;
    if (oldHash === undefined) delete process.env.SNAP_ASTREINTE_TELEGRAM_API_HASH;
    else process.env.SNAP_ASTREINTE_TELEGRAM_API_HASH = oldHash;
  }
});

test("resolveTelegramSession : lève sans api_id ni api_hash", () => {
  const oldTgId = process.env.TELEGRAM_API_ID;
  const oldTgHash = process.env.TELEGRAM_API_HASH;
  const oldId = process.env.SNAP_ASTREINTE_TELEGRAM_API_ID;
  const oldHash = process.env.SNAP_ASTREINTE_TELEGRAM_API_HASH;
  delete process.env.TELEGRAM_API_ID;
  delete process.env.TELEGRAM_API_HASH;
  delete process.env.SNAP_ASTREINTE_TELEGRAM_API_ID;
  delete process.env.SNAP_ASTREINTE_TELEGRAM_API_HASH;
  try {
    assert.throws(() => resolveTelegramSession({}), /TELEGRAM_API_ID est requis/);
  } finally {
    if (oldTgId !== undefined) process.env.TELEGRAM_API_ID = oldTgId;
    if (oldTgHash !== undefined) process.env.TELEGRAM_API_HASH = oldTgHash;
    if (oldId !== undefined) process.env.SNAP_ASTREINTE_TELEGRAM_API_ID = oldId;
    if (oldHash !== undefined) process.env.SNAP_ASTREINTE_TELEGRAM_API_HASH = oldHash;
  }
});

test("loadSessionString : lit le fichier et trim", () => {
  const dir = mkdtempSync(join(tmpdir(), "snap-session-"));
  const file = join(dir, "session.txt");
  writeFileSync(file, "  session-secrete  ");
  try {
    const r = resolveTelegramSession({ apiId: 1, apiHash: "h", sessionFile: file });
    assert.equal(loadSessionString(r), "session-secrete");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSessionString : lève si aucun fichier ni chaîne", () => {
  const dir = mkdtempSync(join(tmpdir(), "snap-session-missing-"));
  const file = join(dir, "absent.txt");
  try {
    const r = resolveTelegramSession({ apiId: 1, apiHash: "h", sessionFile: file });
    assert.throws(() => loadSessionString(r), /Aucune session Telegram/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
