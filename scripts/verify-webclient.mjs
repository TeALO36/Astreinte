#!/usr/bin/env node
/**
 * Vérification comportementale du client Snapchat Web — 7 scénarios.
 *
 * Fait tourner le VRAI client compilé (dist/client/web-client.js) dans des
 * sous-processus Node, contre un faux Snapchat Web servi en local. Le client
 * est pointé vers la fixture via SNAPCHAT_WEB_URL (sans la variable, l'URL
 * réelle reste inchangée). Zéro trafic réel vers Snapchat, aucun compte.
 *
 * Des fenêtres Chromium s'ouvrent brièvement : c'est le vrai comportement du
 * client (premier login / reconnexion en fenêtre visible).
 *
 *   npm run verify:web
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_URL = pathToFileURL(join(ROOT, "dist", "client", "web-client.js")).href;
const BASE_URL = "http://127.0.0.1:8765";

/* ───────────────────────── Fixture : faux Snapchat Web ───────────────────── */

const LOGIN_HTML = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Connexion</title></head><body>
<form id="f">
  <input type="text" name="email" placeholder="Adresse e-mail">
  <button type="submit">Connexion</button>
</form>
<script>
  document.getElementById("f").addEventListener("submit", (e) => {
    e.preventDefault();
    location.href = "/login?step=password";
  });
</script>
</body></html>`;

const PASSWORD_HTML = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Mot de passe</title></head><body>
<input name="password" type="password">
<button type="button" data-testid="password-submit-button">Se connecter</button>
<script>
  document.querySelector("[data-testid='password-submit-button']").addEventListener("click", () => {
    location.href = "/chat";
  });
</script>
</body></html>`;

const CHAT_HTML = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Chats</title></head><body>
<div data-testid="chat-feed">
  <div role="listitem" aria-labelledby="title-c1"><span id="title-c1">Aline Test</span></div>
  <div role="listitem" aria-labelledby="title-c2"><span id="title-c2">Boris Test</span></div>
</div>
<div id="thread">
  <p data-testid="message">Salut, ça va ?</p>
  <p data-testid="message">On se capte ce soir</p>
  <p data-testid="message">Top, à 20h</p>
</div>
<div contenteditable="true" aria-label="Envoyer un Chat"></div>
<input type="file" hidden>
<button aria-label="Démarrer un appel">Appel</button>
<button aria-label="Raccrocher">Raccrocher</button>
</body></html>`;

let fixtureMode = "fresh"; // fresh | wall

function startFixture() {
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    const serve = (body) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    };
    // Les routes du parcours passent AVANT le mode « mur » : même en wall,
    // les étapes password/chat restent servies (sinon la reconnexion ne peut
    // jamais aboutir).
    if (url.startsWith("/login") && url.includes("step=password")) return serve(PASSWORD_HTML);
    if (url === "/chat") return serve(CHAT_HTML);
    if (fixtureMode === "wall") return serve(LOGIN_HTML);
    serve(LOGIN_HTML);
  });
  return new Promise((resolve) => server.listen(8765, "127.0.0.1", () => resolve(server)));
}

/* ─────────────────────── Sous-processus : le vrai client ─────────────────── */

/**
 * Écrit un runner temporaire qui importe le client compilé, exécute `body`
 * puis imprime RESULT:{json}. Le runner tourne avec SNAPCHAT_WEB_URL pointé
 * sur la fixture et un home isolé (state.json à lui).
 */
async function runScenario(body) {
  const home = mkdtempSync(join(tmpdir(), "verify-web-"));
  const stateFile = join(home, "state.json");
  const runner = `
import { WebSnapchatClient } from ${JSON.stringify(DIST_URL)};
import { writeFileSync, existsSync } from "node:fs";
const stateFile = ${JSON.stringify(stateFile)};
globalThis.__result = null;
try {
${body}
} finally {
  console.log("RESULT:" + JSON.stringify(globalThis.__result));
}
`;
  const runnerFile = join(home, "runner.mjs");
  writeFileSync(runnerFile, runner);
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runnerFile], {
      cwd: ROOT,
      env: {
        ...process.env,
        SNAPCHAT_WEB_URL: BASE_URL,
        SNAP_ASTREINTE_HOME: home,
        SNAPCHAT_HEADLESS: "0",
        SNAPCHAT_EMAIL: "",
        SNAPCHAT_PASSWORD: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 240_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", () => { clearTimeout(timer); resolve({ stdout, stderr }); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
  const line = out.stdout.split("\n").find((l) => l.startsWith("RESULT:"));
  let result = null;
  if (line) {
    try { result = JSON.parse(line.slice("RESULT:".length)); } catch { /* corps incomplet */ }
  }
  return { home, result, stderr: out.stderr };
}

/* ───────────────────────────────── Scénarios ─────────────────────────────── */

let failures = 0;
const ok = (label, cond, extra) => {
  console.log((cond ? "PASS" : "FAIL") + " " + label + (extra !== undefined ? " — " + String(extra).slice(0, 300) : ""));
  if (!cond) failures++;
};

const WITH_CREDS = `
process.env.SNAPCHAT_EMAIL = "test@example.com";
process.env.SNAPCHAT_PASSWORD = "test-password";
`;

const server = await startFixture();

/* S1 — Session fraîche : conversations, amis, session persistée. */
{
  const r = await runScenario(WITH_CREDS + `
    const client = new WebSnapchatClient({ timeoutMs: 15000, stateFile });
    const convos = await client.getConversations();
    const friends = await client.listFriends();
    globalThis.__result = {
      convos: convos.map((c) => c.displayName),
      friends: friends.map((f) => f.displayName),
      sessionSaved: existsSync(stateFile),
    };
    await client.close();
  `);
  ok("S1 getConversations lit le faux chat (2 noms)",
    r.result?.convos?.length === 2 && r.result.convos[0] === "Aline Test" && r.result.convos[1] === "Boris Test",
    JSON.stringify(r.result?.convos) + (r.result ? "" : " / stderr: " + r.stderr.slice(-200)));
  ok("S1 listFriends reflète les conversations",
    r.result?.friends?.length === 2 && r.result.friends[0] === "Aline Test");
  ok("S1 session persistée sur disque", r.result?.sessionSaved === true);
  rmSync(r.home, { recursive: true, force: true });
}

/* S2 — Session morte + identifiants : reconnexion automatique (formulaire
 * deux étapes du mur), session ré-enregistrée. */
{
  fixtureMode = "wall";
  const r = await runScenario(WITH_CREDS + `
    writeFileSync(stateFile, JSON.stringify({ cookies: [], origins: [] }));
    const client = new WebSnapchatClient({ timeoutMs: 15000, stateFile });
    const convos = await client.getConversations();
    globalThis.__result = {
      convos: convos.map((c) => c.displayName),
      sessionSaved: existsSync(stateFile),
    };
    await client.close();
  `);
  fixtureMode = "fresh";
  ok("S2 mur détecté → reconnexion auto → conversations servies",
    r.result?.convos?.length === 2, JSON.stringify(r.result?.convos) + (r.result ? "" : " / stderr: " + r.stderr.slice(-200)));
  ok("S2 session ré-enregistrée après reconnexion", r.result?.sessionSaved === true);
  rmSync(r.home, { recursive: true, force: true });
}

/* S3 — Session morte sans identifiants : erreur véridique (pas de fausse
 * fenêtre laissée ouverte). */
{
  fixtureMode = "wall";
  const r = await runScenario(`
    const client = new WebSnapchatClient({ timeoutMs: 15000, stateFile });
    try {
      await client.getConversations();
      globalThis.__result = { error: null };
    } catch (e) {
      globalThis.__result = { error: e.message };
    }
    await client.close();
  `);
  fixtureMode = "fresh";
  const msg = r.result?.error ?? "";
  ok("S3 sans identifiants → erreur franche et véridique",
    typeof r.result?.error === "string"
      && /SNAPCHAT_EMAIL|SNAPCHAT_PASSWORD/.test(msg)
      && !/fenêtre .*ouverte/.test(msg),
    msg || r.stderr.slice(-200));
  rmSync(r.home, { recursive: true, force: true });
}

/* S4 — Session expirée partagée par 3 appels concurrents : une seule
 * reconnexion (single-flight), un seul navigateur, tous servis. */
{
  fixtureMode = "wall";
  const r = await runScenario(WITH_CREDS + `
    writeFileSync(stateFile, JSON.stringify({ cookies: [], origins: [] }));
    const client = new WebSnapchatClient({ timeoutMs: 15000, stateFile });
    const results = await Promise.allSettled([
      client.getConversations(),
      client.getConversations(),
      client.getConversations(),
    ]);
    globalThis.__result = {
      fulfilled: results.filter((x) => x.status === "fulfilled" && x.value.length === 2).length,
      browserAlive: client.browser !== null,
      pages: client.browser ? client.browser.contexts().reduce((n, c) => n + c.pages().length, 0) : -1,
    };
    await client.close();
  `);
  fixtureMode = "fresh";
  ok("S4 3 appels concurrents → tous servis, 1 seul navigateur",
    r.result?.fulfilled === 3 && r.result?.browserAlive === true && r.result?.pages === 1,
    JSON.stringify(r.result) + (r.result ? "" : " / stderr: " + r.stderr.slice(-200)));
  rmSync(r.home, { recursive: true, force: true });
}

/* S5 — state.json corrompu : le lancement survit (reprise sans session). */
{
  const r = await runScenario(WITH_CREDS + `
    writeFileSync(stateFile, "{corrompu");
    const client = new WebSnapchatClient({ timeoutMs: 15000, stateFile });
    const convos = await client.getConversations();
    globalThis.__result = { convos: convos.map((c) => c.displayName) };
    await client.close();
  `);
  ok("S5 state.json corrompu → lancement survit, conversations servies",
    r.result?.convos?.length === 2, JSON.stringify(r.result?.convos) + (r.result ? "" : " / stderr: " + r.stderr.slice(-200)));
  rmSync(r.home, { recursive: true, force: true });
}

/* S6 — Lecture des messages : exactement les 3 messages du fil, sans les
 * lignes de la liste de conversations (le bug « noms de contacts »). */
{
  const r = await runScenario(WITH_CREDS + `
    const client = new WebSnapchatClient({ timeoutMs: 15000, stateFile });
    await client.getConversations();
    const messages = await client.getMessages("Aline Test");
    globalThis.__result = { texts: messages.map((m) => m.text) };
    await client.close();
  `);
  const texts = r.result?.texts ?? [];
  ok("S6 getMessages renvoie 3 messages du fil, aucune contamination sidebar",
    texts.length === 3 && texts.includes("Salut, ça va ?") && !texts.includes("Boris Test"),
    JSON.stringify(texts) + (r.result ? "" : " / stderr: " + r.stderr.slice(-200)));
  rmSync(r.home, { recursive: true, force: true });
}

/* S7 — Machine à états des appels : start → ringing_outgoing, fin propre
 * (le correctif « raccrocher »), IDs inconnus rejetés sans effet de bord. */
{
  const r = await runScenario(WITH_CREDS + `
    const client = new WebSnapchatClient({ timeoutMs: 15000, stateFile });
    await client.getConversations();
    const call = await client.startVoiceCall({ conversationId: "Aline Test" });
    // endVoiceCall mute le même objet : capturer l'état initial AVANT la fin.
    const startedOk = call.state === "ringing_outgoing" && Boolean(call.callId);
    const active = await client.getActiveCall();
    let unknownRejected = null;
    try {
      await client.endVoiceCall("web_call_inconnu");
      unknownRejected = false;
    } catch (e) {
      unknownRejected = /inconnu|Aucun appel/.test(e.message);
    }
    const ended = await client.endVoiceCall(call.callId);
    globalThis.__result = {
      started: startedOk,
      activeMatches: active?.callId === call.callId,
      unknownRejected,
      ended: ended.state === "ended" && ended.endReason === "hung_up",
      emptyAfterEnd: (await client.getActiveCall()) === null,
    };
    await client.close();
  `);
  const x = r.result ?? {};
  ok("S7 startVoiceCall → ringing_outgoing", x.started === true, r.result ? "" : r.stderr.slice(-200));
  ok("S7 getActiveCall voit l'appel", x.activeMatches === true);
  ok("S7 endVoiceCall rejette un ID inconnu", x.unknownRejected === true);
  ok("S7 endVoiceCall (raccrocher) → ended/hung_up, plus d'appel actif",
    x.ended === true && x.emptyAfterEnd === true, JSON.stringify(x));
  rmSync(r.home, { recursive: true, force: true });
}

server.close();
console.log(failures === 0 ? "\nVERIFY:WEB — 7/7 SCÉNARIOS PASSENT" : `\nVERIFY:WEB — ${failures} ÉCHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
