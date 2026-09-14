#!/usr/bin/env node
/**
 * Vérification E2E du Persona Studio — aucun compte, aucun trafic réel.
 *
 * Démarre le banc (donc le studio), puis prouve sur les VRAIES routes HTTP :
 *   A/B  pages servies (studio + lien depuis le banc)
 *   C–E  éditeur : schéma du manifeste, boucle de config, prompt système RÉEL
 *   F    info Morph (variables supportées, sections de réglages)
 *   G    démarrage du VRAI démon contre le pont simulé
 *   H    message → réponse du persona (politique → LLM mock → pont)
 *   I    demande de vocal → note vocale WAV jouable
 *   J    demande d'image → image PNG reçue
 *   K    demande interdite → escalade (message configuré, sans LLM)
 *   L    silence après escalade, qui SURVIT à un redémarrage (contexte persisté)
 *   M/N  reset interdit si actif, puis reset et reprise propre
 *   O    bornes : 409/400/404 sur les mauvaises entrées
 *   P    le banc d'origine fonctionne toujours (outils MCP découverts)
 */

import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PORT = 8891 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const ok = (label, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${extra !== undefined ? ` — ${extra}` : ""}`);
  if (!cond) failures += 1;
};

const api = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, body
    ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    : {});
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
};

async function waitFor(desc, fn, timeoutMs = 30_000, stepMs = 300) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`délai dépassé : ${desc} (dernier état : ${JSON.stringify(last)?.slice(0, 300)})`);
}

const history = async () => (await api("/api/studio/history")).json.history;
const findIn = (items, pred) => [...items].reverse().find(pred);

const bench = spawn(process.execPath, [join(ROOT, "scripts", "test-bench-app.mjs"), "--port", String(PORT), "--no-open"], {
  cwd: ROOT,
  env: { ...process.env, SNAPMCP_BENCH_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let benchOut = "";
bench.stdout.on("data", (d) => (benchOut += String(d)));
bench.stderr.on("data", (d) => (benchOut += String(d)));

try {
  await waitFor("banc en écoute", async () => {
    try {
      return (await fetch(`${BASE}/studio`)).ok ? true : undefined;
    } catch {
      return undefined;
    }
  }, 20_000);

  // ---------------------------------------------------------- pages
  const page = await fetch(`${BASE}/studio`);
  const pageText = await page.text();
  ok("A. page /studio servie", page.ok && pageText.includes("Persona Studio"));
  const home = await (await fetch(`${BASE}/`)).text();
  ok("B. lien Studio sur le banc", home.includes('href="/studio"'));

  // ------------------------------------------------- éditeur de persona
  const { json: schemaResp } = await api("/api/studio/schema");
  ok("C. schéma du manifeste servi", Boolean(schemaResp.schema?.["persona.name"] && schemaResp.schema?.["limits.enabled"]));

  const saved = await api("/api/studio/config/save", {
    config: { "persona.name": "StudioTest", "limits.escalation_keywords": "urgent,remboursement" },
  });
  ok("D1. boucle de config (écrit = relu)", saved.status === 200 && saved.json.config?.["persona.name"] === "StudioTest");
  const bogus = await api("/api/studio/config/save", { config: { "nimportequoi.x": 1 } });
  ok("D2. clé inconnue signalée", bogus.json.unknownKeys?.includes("nimportequoi.x"));

  const { json: promptResp } = await api("/api/studio/prompt");
  ok(
    "E. prompt système réel (nom + garde-fous)",
    promptResp.prompt?.includes("StudioTest") && promptResp.prompt?.includes("Tu traites uniquement"),
  );

  // ------------------------------------------------- fichier persona
  const envelope = (await api("/api/studio/export")).json;
  ok(
    "Q1. export = enveloppe versionnée",
    envelope.format === "snap-astreinte-persona" &&
      envelope.version === 1 &&
      typeof envelope.config === "object" &&
      envelope.config?.["persona.name"] === "StudioTest",
  );
  ok("Q2. aucun secret dans l'export", !JSON.stringify(envelope).includes('"llm.api_key"'));

  const secretSave = await api("/api/studio/config/save", { config: { "llm.api_key": "sk-vraiment-secret" } });
  ok("Q3. le secret est enregistré côté studio", secretSave.status === 200);
  ok("Q4. le secret n'apparaît pas même après enregistrement", !JSON.stringify((await api("/api/studio/export")).json).includes("sk-vraiment-secret"));

  // Fichier plat (une config brute) → fusion simple.
  const flat = await api("/api/studio/import", { "persona.name": "Importe" });
  ok(
    "Q5. import plat = fusion (le reste de la config est conservé)",
    flat.status === 200 &&
      flat.json.imported === 1 &&
      flat.json.config?.["persona.name"] === "Importe" &&
      flat.json.config?.["limits.escalation_keywords"]?.length > 0,
  );

  // Enveloppe d'export → le fichier EST la persona : remise aux défauts puis
  // application. C'est aussi ce qui restaure l'état attendu par la suite.
  const restore = await api("/api/studio/import", envelope);
  // Après remplacement, la config contient toutes les clés du schéma à leurs
  // défauts : le secret doit avoir disparu (chaîne vide), pas être undefined.
  ok(
    "Q6. import enveloppe = remplacement + secret évincé",
    restore.status === 200 &&
      restore.json.config?.["persona.name"] === "StudioTest" &&
      !restore.json.config?.["llm.api_key"] &&
      restore.json.imported >= 2,
  );

  ok("Q7. enveloppe inconnue → 400", (await api("/api/studio/import", { format: "autre-chose" })).status === 400);
  const secretIgnored = await api("/api/studio/import", { "llm.api_key": "sk-x" });
  ok(
    "Q8. clé secrète dans un import → ignorée et signalée",
    secretIgnored.status === 200 && secretIgnored.json.ignoredSecrets?.includes("llm.api_key"),
  );

  // ---------------------------------------------------------- Morph
  const { json: morph } = await api("/api/studio/morph");
  ok(
    "F. info Morph",
    morph.name === "snap-astreinte" &&
      morph.mcpVariables.includes("LOCARYN_PLUGIN_ROOT") &&
      morph.mcpVariableWarning === false &&
      morph.settingsSections.length >= 4,
  );

  // ------------------------------------------------- situation réelle
  ok("O1. envoi avant démarrage → 409", (await api("/api/studio/send", { contactId: "x", text: "hi" })).status === 409);

  const start = await api("/api/studio/persona/start", { llmMode: "mock" });
  ok("G1. démarrage accepté", start.status === 202 && start.json.running);
  const ready = await waitFor("démon prêt (canal ouvert)", async () => {
    const s = (await api("/api/studio/persona/status")).json;
    return s.ready ? s : undefined;
  }, 25_000);
  ok("G2. démon prêt contre le pont", ready.ready && ready.llmMode === "mock");

  await api("/api/studio/send", { contactId: "v1", contactName: "Marc", text: "Bonjour, mon wifi coupe." });
  const reply = await waitFor("réponse du persona à v1", async () =>
    findIn(await history(), (m) => m.direction === "outgoing" && m.contactId === "v1" && m.kind === "text"),
  );
  ok("H. message → réponse du persona", reply.text.includes("StudioTest"), reply.text.slice(0, 80));

  await api("/api/studio/send", { contactId: "v1", text: "Tu peux me faire un vocal pour m'expliquer ?" });
  const voice = await waitFor("note vocale pour v1", async () =>
    findIn(await history(), (m) => m.direction === "outgoing" && m.contactId === "v1" && m.kind === "voice"),
  );
  const wav = Buffer.from(voice.audioBase64, "base64");
  ok("I. vocal jouable (WAV réel)", wav.subarray(0, 4).toString("ascii") === "RIFF" && wav.length > 100, `${wav.length} octets`);

  await api("/api/studio/send", { contactId: "v1", text: "Peux-tu me générer une image de chat, stp ?" });
  const image = await waitFor("image pour v1", async () =>
    findIn(await history(), (m) => m.direction === "outgoing" && m.contactId === "v1" && m.kind === "image"),
  );
  const png = Buffer.from(image.mediaBase64, "base64");
  ok("J. image reçue (PNG réel)", png.subarray(1, 4).toString("ascii") === "PNG", `${png.length} octets`);

  const escalation = await api("/api/studio/send", {
    contactId: "v1",
    text: "C'est urgent, je veux un remboursement immédiat sinon j'appelle mon avocat.",
  });
  ok("K1. demande interdite acceptée", escalation.status === 202);
  const escMsg = await waitFor("message d'escalade pour v1", async () => {
    const items = await history();
    const texts = items.filter((m) => m.direction === "outgoing" && m.contactId === "v1" && m.kind === "text");
    return texts.length >= 2 ? texts[texts.length - 1] : undefined;
  });
  ok(
    "K2. escalade = message configuré (sans LLM)",
    escMsg.text === "Là je préfère que ce soit traité directement — je transmets, on te répond dès que possible.",
    escMsg.text.slice(0, 60),
  );

  const textsBefore = () =>
    (async () => (await history()).filter((m) => m.direction === "outgoing" && m.contactId === "v1" && m.kind === "text").length)();
  const baseline1 = await textsBefore();
  await api("/api/studio/send", { contactId: "v1", text: "hello, toujours là ?" });
  await new Promise((r) => setTimeout(r, 2500));
  ok("L1. silence après escalade", (await textsBefore()) === baseline1);

  // Redémarrage : le verrou d'escalade et le contexte doivent survivre.
  await api("/api/studio/persona/stop");
  const stopped = (await api("/api/studio/persona/status")).json;
  ok("L2. arrêt propre", stopped.running === false);
  await api("/api/studio/persona/start", { llmMode: "mock" });
  await waitFor("démon prêt après redémarrage", async () =>
    (await api("/api/studio/persona/status")).json.ready ? true : undefined, 25_000);
  const baseline3 = await textsBefore();
  await api("/api/studio/send", { contactId: "v1", text: "rebonjour" });
  await new Promise((r) => setTimeout(r, 2500));
  ok("L3. escalade persistée après redémarrage", (await textsBefore()) === baseline3);

  // ------------------------------------------------- reset + reprise
  ok("M. reset interdit si actif", (await api("/api/studio/reset")).status === 409);
  await api("/api/studio/persona/stop");
  ok("N1. reset puis history vide", (await api("/api/studio/reset")).status === 200 && (await history()).length === 0);
  await api("/api/studio/persona/start", { llmMode: "mock" });
  await waitFor("démon prêt après reset", async () =>
    (await api("/api/studio/persona/status")).json.ready ? true : undefined, 25_000);
  await api("/api/studio/send", { contactId: "v2", contactName: "Léa", text: "Nouvelle conversation, bonjour." });
  const v2 = await waitFor("réponse au nouveau contact", async () =>
    findIn(await history(), (m) => m.direction === "outgoing" && m.contactId === "v2" && m.kind === "text"),
  );
  ok("N2. persona de nouveau opérationnel", v2.text.includes("StudioTest"));

  // ---------------------------------------------------------- bornes
  ok("O2. message vide → 400", (await api("/api/studio/send", { contactId: "v2", text: "  " })).status === 400);
  ok("O3. config invalide → 400", (await api("/api/studio/config/save", { config: "oops" })).status === 400);
  ok("O4. pont sans contactId → 400", (await api("/bridge/send", { text: "x" })).status === 400);
  ok("O5. route studio inconnue → 404", (await api("/api/studio/nimporte")).status === 404);

  // ------------------------------------------------- régression banc
  const tools = await api("/api/tools", { backend: "mock" });
  ok("P. banc d'origine intact (outils MCP)", Array.isArray(tools.json.tools) && tools.json.tools.length === 17, `${tools.json.tools?.length} outils`);
} catch (e) {
  failures += 1;
  console.log(`FAIL exception — ${e.message}`);
} finally {
  try {
    await api("/api/studio/persona/stop");
  } catch { /* banc déjà mort */ }
  bench.kill();
}

console.log(failures === 0 ? "\nverify:studio — tous les scénarios passent." : `\nverify:studio — ${failures} échec(s).`);
if (failures > 0) console.log(`— sortie du banc —\n${benchOut.slice(-1500)}`);
process.exit(failures === 0 ? 0 : 1);
