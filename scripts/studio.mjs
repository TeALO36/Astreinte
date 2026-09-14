#!/usr/bin/env node
/**
 * Persona Studio — monté dans le banc (scripts/test-bench-app.mjs).
 *
 * Trois volets, zéro trafic Snapchat ou Telegram réel :
 *
 *  1. **Éditeur de persona** — formulaire construit sur le schéma du manifeste
 *     (plugin.json), aperçu du prompt système EFFECTIF (le vrai, celui que le
 *     démon envoie au modèle), sauvegarde dans le même fichier que lit le démon.
 *  2. **Morph** — état de l'intégration Locaryn : variables du manifeste MCP,
 *     sections de réglages que l'application affichera, pas d'installation.
 *  3. **Situation réelle** — le VRAI démon (`dist/index.js daemon`,
 *     transport.driver=bridge) tourne contre le pont conforme au contrat de
 *     src/transports/bridge.ts servi ici : vous écrivez comme un
 *     correspondant, le persona répond. Contexte par contact, garde-fous,
 *     escalade, notes vocales, images — toute la chaîne, sans aucun compte.
 *
 * Le LLM est « mock » (réponses composées ici, assez pour prouver la chaîne)
 * ou « local » (llama-server déjà lancé sur 127.0.0.1:8080). En mode mock, TTS
 * et image ont un serveur factice aux formats réels (WAV, b64_json).
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { Agent } from "../dist/agent.js";
import { Config, loadSchema } from "../dist/config.js";
import { loadDotEnv } from "../dist/env.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ENTRY = join(ROOT, "dist", "index.js");

const STUDIO_HTML = String.raw`<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Persona Studio — banc SnapMCP</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,Segoe UI,sans-serif;background:#0f1419;color:#f0f2f5;line-height:1.5}
main{max-width:960px;margin:0 auto;padding:20px}
h1{font-size:1.4rem;margin:0 0 4px}
h2{font-size:1.05rem;margin:28px 0 10px;color:#6b9e7c;border-bottom:1px solid rgba(255,255,255,.1);padding-bottom:6px}
a{color:#6b9e7c}
.muted{color:#9ca3af;font-size:.85rem}
section,fieldset{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:14px;margin-bottom:14px}
fieldset{min-width:0}
legend{padding:0 6px;font-size:.85rem;color:#6b9e7c}
label{display:block;font-size:.82rem;color:#9ca3af;margin:8px 0 3px}
input,textarea,select{width:100%;background:#0f1419;color:#f0f2f5;border:1px solid rgba(255,255,255,.15);border-radius:6px;padding:7px;font:inherit}
textarea{min-height:56px;resize:vertical}
input:focus,textarea:focus,select:focus{outline:1px solid #4a7c59}
button{background:#4a7c59;color:#fff;border:0;border-radius:6px;padding:8px 14px;font:inherit;cursor:pointer;margin:8px 6px 0 0}
button:hover{background:#6b9e7c}
button.ghost{background:transparent;border:1px solid rgba(255,255,255,.25)}
button.danger{background:#7c3a3a}
button:disabled{opacity:.45;cursor:default}
pre{background:#0a0e12;border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:10px;font-size:.75rem;white-space:pre-wrap;max-height:260px;overflow:auto}
.chat{display:flex;flex-direction:column;gap:6px;max-height:340px;overflow:auto;background:#0a0e12;border-radius:8px;padding:10px}
.msg{max-width:85%;padding:7px 11px;border-radius:10px;font-size:.88rem}
.msg.in{align-self:flex-start;background:rgba(255,255,255,.08)}
.msg.out{align-self:flex-end;background:#25432f}
.msg .k{font-size:.68rem;opacity:.65}
.msg img,.msg audio{max-width:220px;display:block;margin-top:4px;border-radius:6px}
.row{display:flex;gap:8px;align-items:flex-end}
.row>*{flex:1}
.scen{display:flex;flex-wrap:wrap}
.scen button{font-size:.78rem;padding:5px 10px;background:transparent;border:1px solid rgba(255,255,255,.2)}
.badge{display:inline-block;padding:2px 9px;border-radius:99px;font-size:.75rem;border:1px solid rgba(255,255,255,.2)}
.badge.on{color:#10b981;border-color:#10b981}
.badge.off{color:#9ca3af}
.warn{color:#f59e0b;font-size:.82rem}
</style></head><body><main>
<p class="muted"><a href="/">← Banc SnapMCP</a> · Persona Studio</p>
<h1>Persona Studio</h1>
<p class="muted">Configure le Morph, prévisualise son prompt réel, puis converse avec lui — la chaîne complète (persona, garde-fous, escalade, vocal, image) tourne ici sans aucun compte.</p>

<h2>1 · Persona</h2>
<section><div id="editor"><span class="muted">Chargement du schéma…</span></div>
<button id="save">Enregistrer</button> <button id="reload" class="ghost">Recharger</button> <button id="exportBtn" class="ghost">Exporter en fichier</button> <button id="importBtn" class="ghost">Importer un fichier…</button><input id="importFile" type="file" accept="application/json,.json" hidden>
<label id="examplesLabel" style="margin-top:12px">Personas d'exemple — un clic charge celle-ci (et remplace la persona actuelle)</label>
<div class="scen" id="examples"><span class="muted">…</span></div>
<span id="saveState" class="muted"></span>
<label style="margin-top:14px">Aperçu du prompt système réel (pour un message entrant « Salut, mon wifi coupe »)</label>
<pre id="prompt">…</pre></section>

<h2>2 · Morph (intégration Locaryn)</h2>
<section id="morph"><span class="muted">…</span></section>

<h2>3 · Situation réelle</h2>
<section>
<p class="muted">Lance le vrai démon contre un pont simulé. Modifie la persona ci-dessus, redémarre, elle s'applique.</p>
<p><span class="badge off" id="runBadge">arrêté</span> <span class="muted" id="runInfo"></span></p>
<label>Moteur de réponse</label>
<select id="llmMode"><option value="mock">Simulé (aucun modèle requis)</option><option value="local">Modèle local (llama-server sur 127.0.0.1:8080)</option></select>
<button id="start">Démarrer le persona</button> <button id="stop" class="danger" disabled>Arrêter</button>
<label>Contact (identifiant stable = mémoire de la conversation)</label>
<div class="row"><input id="cid" value="studio-1"><input id="cname" value="Correspondant test"></div>
<button id="newContact" class="ghost">Nouveau correspondant</button>
<label>Scénarios</label>
<div class="scen">
<button data-t="Bonjour, mon wifi coupe dès que je lance un téléchargement.">Wi-Fi qui coupe</button>
<button data-t="Tu peux me faire un vocal pour m'expliquer ?">Demande de vocal</button>
<button data-t="Peux-tu me générer une image de chat, stp ?">Demande d'image</button>
<button data-t="C'est urgent, je veux un remboursement immédiat sinon j'appelle mon avocat.">Demande interdite</button>
</div>
<div class="chat" id="chat"></div>
<div class="row"><input id="txt" placeholder="Écrire comme le correspondant…"></div>
<button id="send">Envoyer</button>
<details><summary class="muted">Journal du démon</summary><pre id="dlog"></pre></details>
</section>
<script>
const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function api(p,body){const r=await fetch(p,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||String(r.status));return j}
function field(k,f,val){let el;
 if(f.type==='boolean'){el=document.createElement('input');el.type='checkbox';el.checked=!!val;}
 else if(f.type==='select'){el=document.createElement('select');(f.options||[]).forEach((o,i)=>{const op=document.createElement('option');op.value=o;op.textContent=(f.optionLabels&&f.optionLabels[i])||o;if(o===val)op.selected=true;el.append(op)})}
 else if(f.type==='text'){el=document.createElement('textarea');el.value=val==null?'':val}
 else if(f.type==='list'){el=document.createElement('textarea');el.value=Array.isArray(val)?val.join("\n"):(val==null?'':val)}
 else{el=document.createElement('input');el.type=f.type==='secret'?'password':(f.type==='number'?'number':'text');if(f.type==='number'){if(f.min!=null)el.min=f.min;if(f.max!=null)el.max=f.max;if(f.step!=null)el.step=f.step}el.value=val==null?'':val}
 const lab=document.createElement('label');lab.dataset.key=k;lab.append(el);
 lab.append(document.createTextNode(' '+(f.title||k)+(f.description?' — '+f.description:'')));return lab}
async function renderEditor(){const{schema}=await api('/api/studio/schema');window.__schema=schema;const{config}=await api('/api/studio/config');const box=$('editor');box.innerHTML='';
 const groups=new Map();for(const[k,f]of Object.entries(schema)){const g=f.group||'Divers';if(!groups.has(g))groups.set(g,[]);groups.get(g).push([k,f])}
 for(const[g,fields]of groups){const fs=document.createElement('fieldset');const lg=document.createElement('legend');lg.textContent=g;fs.append(lg);
  for(const[k,f]of fields)fs.append(field(k,f,config[k]));box.append(fs)}}
async function save(){const patch={};document.querySelectorAll('#editor label[data-key]').forEach(lab=>{const k=lab.dataset.key;const el=lab.querySelector('input,select,textarea');const f=window.__schema[k];
  patch[k]=f&&f.type==='boolean'?el.checked:(f&&f.type==='number'?Number(el.value):el.value)});
 try{const r=await api('/api/studio/config/save',{config:patch});$('saveState').textContent='Enregistré'+(r.unknownKeys.length?' (inconnus : '+r.unknownKeys.join(', ')+')':'');promptPreview()}catch(e){$('saveState').textContent='Erreur : '+e.message}}
async function promptPreview(){try{const{prompt}=await api('/api/studio/prompt');$('prompt').textContent=prompt}catch(e){$('prompt').textContent='('+e.message+')'}}
async function renderMorph(){const m=await api('/api/studio/morph');let h='<b>'+esc(m.name||'?')+'</b> <span class="muted">v'+esc(m.version||'?')+'</span><p class="muted">'+esc(m.description||'')+'</p>';
 h+='<p class="muted">Sections de réglages dans l\'application : '+(m.settingsSections.map(s=>esc(s.label)+' ('+s.fields+' champs)').join(' · ')||'aucune')+'</p>';
 h+='<p class="muted">Variables MCP : '+m.mcpVariables.map(esc).join(', ')+' — supportées : '+m.supportedVariables.map(esc).join(', ')+'</p>';
 if(m.mcpVariableWarning)h+='<p class="warn">⚠ Une variable du manifeste MCP n\'est pas supportée par Locaryn : le serveur ne démarrerait pas dans l\'application.</p>';
 h+='<p class="muted">Installation : '+m.installSteps.map(esc).join(' → ')+'</p>';$('morph').innerHTML=h}
function bubble(m){const d=document.createElement('div');d.className='msg '+(m.direction==='incoming'?'in':'out');
 let body='';if(m.kind==='text')body=esc(m.text);else if(m.kind==='voice')body='<span class="k">note vocale</span><audio controls src="data:'+esc(m.mimeType)+';base64,'+m.audioBase64+'"></audio>';
 else if(m.kind==='image')body='<img src="data:'+esc(m.mimeType)+';base64,'+m.mediaBase64+'">'+(m.caption?'<div class="k">'+esc(m.caption)+'</div>':'');
 d.innerHTML=body+'<div class="k">'+(m.direction==='incoming'?'←':'→')+' '+esc(m.contactId)+' · '+new Date(m.at).toLocaleTimeString()+'</div>';$('chat').append(d);$('chat').scrollTop=1e9}
function refreshHistory(){api('/api/studio/history').then(({history})=>{$('chat').innerHTML='';history.forEach(bubble)})}
async function refreshStatus(){try{const s=await api('/api/studio/persona/status');$('runBadge').textContent=s.running?('actif ('+s.llmMode+')'):'arrêté';$('runBadge').className='badge '+(s.running?'on':'off');
 $('start').disabled=s.running;$('stop').disabled=!s.running;$('runInfo').textContent=s.running?('pont : '+s.bridge):'';$('dlog').textContent=s.lastStderr||''}catch(e){}}
$('save').onclick=save;$('reload').onclick=()=>renderEditor().then(promptPreview);
$('exportBtn').onclick=async()=>{try{const data=await api('/api/studio/export',{});const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=(data.name||'persona').replace(/[^a-zA-Z0-9_-]+/g,'-').toLowerCase()+'.persona.json';a.click();URL.revokeObjectURL(a.href);$('saveState').textContent='Exporté : '+a.download}catch(e){$('saveState').textContent='Erreur : '+e.message}};
$('importBtn').onclick=()=>$('importFile').click();
$('importFile').onchange=async()=>{const file=$('importFile').files[0];$('importFile').value='';if(!file)return;try{const body=JSON.parse(await file.text());const r=await api('/api/studio/import',body);await renderEditor();promptPreview();let msg='Importé : '+r.imported+' réglage(s)';if(r.unknownKeys.length)msg+=' · inconnus ignorés : '+r.unknownKeys.join(', ');if(r.ignoredSecrets.length)msg+=' · secrets non importés : '+r.ignoredSecrets.join(', ');$('saveState').textContent=msg}catch(e){$('saveState').textContent='Import refusé : '+e.message}};
api('/api/studio/examples').then(({examples})=>{examples=examples||[];if(!examples.length){$('examplesLabel').textContent='';return}const box=$('examples');box.innerHTML='';examples.forEach(x=>{const b=document.createElement('button');b.title=x.description||'';b.textContent=x.name;b.onclick=async()=>{try{const ex=await api('/api/studio/example',{id:x.id});const r=await api('/api/studio/import',ex);await renderEditor();promptPreview();$('saveState').textContent='Persona chargée : '+x.name+(r.ignoredSecrets&&r.ignoredSecrets.length?' (secrets évincés : '+r.ignoredSecrets.join(', ')+')':'')}catch(e){$('saveState').textContent='Erreur : '+e.message}};box.append(b)})}).catch(()=>{$('examplesLabel').textContent=''})
$('start').onclick=async()=>{try{await api('/api/studio/persona/start',{llmMode:$('llmMode').value})}catch(e){alert(e.message)}refreshStatus()};
$('stop').onclick=async()=>{await api('/api/studio/persona/stop');refreshStatus()};
$('newContact').onclick=()=>{$('cid').value='studio-'+Math.random().toString(36).slice(2,7)};
function send(){const t=$('txt').value.trim();if(!t)return;const cid=$('cid').value.trim()||'studio-1';
 api('/api/studio/send',{contactId:cid,contactName:$('cname').value.trim(),text:t}).then(()=>{$('txt').value=''}).catch(e=>alert(e.message))}
$('send').onclick=send;
$('txt').addEventListener('keydown',e=>{if(e.key==='Enter')send()});
document.querySelectorAll('.scen button').forEach(b=>b.onclick=()=>{$('txt').value=b.dataset.t;send()});
const es=new EventSource('/api/studio/events');es.onmessage=e=>{bubble(JSON.parse(e.data))};
renderEditor().then(promptPreview);renderMorph();refreshHistory();refreshStatus();setInterval(refreshStatus,2000);
</script></main></body></html>`;

/**
 * Fabrique montée une fois par banc. Retourne un objet avec :
 *  - `route(req,res)` : gère une requête studio/pont, true si traitée ;
 *  - `setBenchPort(port)` : appelé par le banc au démarrage — le démon doit
 *    connaître l'URL du pont, qui vit sur le même serveur HTTP que la page ;
 *  - `shutdown()` : arrête démon et serveurs factices.
 */
export function createStudio() {
  const home = mkdtempSync(join(tmpdir(), "snapmcp-studio-"));
  mkdirSync(join(home, "contacts"), { recursive: true });
  // La config du studio EST celle du démon (même SNAP_ASTREINTE_HOME) :
  // sauvegarder ici, c'est déjà configurer le persona qui va démarrer.
  process.env.SNAP_ASTREINTE_HOME = home;
  loadDotEnv();

  const store = {
    child: null,
    llmMode: null,
    benchPort: Number(process.env.SNAPMCP_BENCH_PORT || 8787),
    log: [],
    history: [],
    bridgeClients: new Set(),
    uiClients: new Set(),
    mocks: null,
  };

  return { route, setBenchPort, shutdown, home };

  function setBenchPort(port) {
    store.benchPort = port;
  }

  function bridgeUrl() {
    return `http://127.0.0.1:${store.benchPort}/bridge`;
  }

  // --------------------------------------------------------------- routage
  async function route(req, res) {
    const p = (req.url ?? "/").split("?")[0];
    if (p === "/studio" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(STUDIO_HTML);
      return true;
    }
    if (p === "/api/studio/events" && req.method === "GET") {
      sse(req, res, store.uiClients);
      return true;
    }
    if (p === "/bridge/events" && req.method === "GET") {
      sse(req, res, store.bridgeClients);
      return true;
    }
    if (p.startsWith("/api/studio/") || p.startsWith("/bridge/")) {
      const value = req.method === "POST" ? await readJson(req) : {};
      return handle(req, res, p, value);
    }
    return false;
  }

  function sse(req, res, clients) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connecté\n\n");
    clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    ping.unref?.();
    req.on("close", () => {
      clearInterval(ping);
      clients.delete(res);
    });
  }

  async function handle(req, res, p, value) {
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return true;
    };
    switch (p) {
      // ------------------------------------------------- persona (config)
      case "/api/studio/schema":
        return json(200, { schema: loadSchema() });
      case "/api/studio/config":
        return json(200, { config: storedConfig() });
      case "/api/studio/config/save": {
        const patch = value?.config ?? value;
        if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
          return json(400, { error: "config absente ou invalide." });
        }
        const { unknownKeys } = Config.load().update(patch);
        return json(200, { config: storedConfig(), unknownKeys });
      }
      case "/api/studio/prompt":
        return json(200, { prompt: effectivePrompt() });

      // ------------------------------------------------- persona (fichier)
      case "/api/studio/export":
        return json(200, exportPersona());
      case "/api/studio/import":
        return importPersona(json, value);
      case "/api/studio/examples":
        return json(200, { examples: listPersonaExamples() });
      case "/api/studio/example": {
        const found = readPersonaExample(String(value?.id ?? ""));
        if (!found) return json(404, { error: "Persona d'exemple introuvable." });
        return json(200, found);
      }

      // ------------------------------------------------- Morph
      case "/api/studio/morph":
        return json(200, morphInfo());

      // ------------------------------------------------- démon
      case "/api/studio/persona/start":
        return startPersona(json, value);
      case "/api/studio/persona/stop":
        await stopPersona();
        return json(200, status());
      case "/api/studio/persona/status":
        return json(200, status());

      // ------------------------------------------------- conversation
      case "/api/studio/send": {
        if (!store.child) return json(409, { error: "Le persona n'est pas démarré." });
        const text = String(value?.text ?? "").trim();
        const contactId = String(value?.contactId ?? "").trim();
        if (!text || !contactId) return json(400, { error: "text et contactId requis." });
        // Le démon n'est « démarré » qu'une fois son flux /bridge/events
        // ouvert : un message émis avant serait perdu sans trace. On attend
        // la connexion plutôt que de simuler un envoi fictif.
        try {
          await waitForBridge();
        } catch {
          return json(503, { error: "Le persona n'a pas ouvert le canal (voir le journal)." });
        }
        record({
          direction: "incoming",
          contactId,
          kind: "text",
          text,
          at: Date.now(),
        });
        broadcast(store.bridgeClients, {
          contactId,
          contactName: String(value?.contactName ?? "").trim() || undefined,
          text,
          isVoice: value?.isVoice === true,
          receivedAt: Date.now(),
        });
        return json(202, { accepted: true });
      }
      case "/api/studio/history":
        return json(200, { history: store.history.slice(-200) });
      case "/api/studio/reset": {
        if (store.child) return json(409, { error: "Arrêtez le persona avant de réinitialiser." });
        rmSync(join(home, "contacts"), { recursive: true, force: true });
        store.history.length = 0;
        return json(200, { ok: true });
      }

      // ------------------------------------------------- pont (contrat)
      case "/bridge/health":
        return json(200, { ok: true, voice: true, images: true, detail: "Studio — correspondant simulé" });
      case "/bridge/send": {
        const contactId = String(value?.contactId ?? "").trim();
        if (!contactId || typeof value?.text !== "string") {
          return json(400, { error: "contactId et text requis." });
        }
        record({ direction: "outgoing", contactId, kind: "text", text: value.text, at: Date.now() });
        return json(200, { ok: true });
      }
      case "/bridge/sendVoice": {
        const contactId = String(value?.contactId ?? "").trim();
        const audio = Buffer.from(String(value?.audioBase64 ?? ""), "base64");
        if (!contactId || !audio.length) return json(400, { error: "contactId et audioBase64 requis." });
        record({
          direction: "outgoing",
          contactId,
          kind: "voice",
          audioBase64: audio.toString("base64"),
          mimeType: String(value?.mimeType ?? "audio/ogg"),
          at: Date.now(),
        });
        return json(200, { ok: true });
      }
      case "/bridge/sendMedia": {
        const contactId = String(value?.contactId ?? "").trim();
        const media = Buffer.from(String(value?.mediaBase64 ?? ""), "base64");
        if (!contactId || !media.length) return json(400, { error: "contactId et mediaBase64 requis." });
        record({
          direction: "outgoing",
          contactId,
          kind: "image",
          mediaBase64: media.toString("base64"),
          mimeType: String(value?.mimeType ?? "image/png"),
          caption: typeof value?.caption === "string" ? value.caption : "",
          at: Date.now(),
        });
        return json(200, { ok: true });
      }
      default:
        return json(404, { error: "Route studio inconnue." });
    }
  }

  /** Résolu dès qu'un consommateur écoute /bridge/events (le démon). */
  function waitForBridge(timeoutMs = 15_000) {
    if (store.bridgeClients.size > 0) return Promise.resolve();
    return new Promise((resolveDone, rejectDone) => {
      const timer = setTimeout(() => {
        clearInterval(check);
        rejectDone(new Error("timeout"));
      }, timeoutMs);
      const check = setInterval(() => {
        if (store.bridgeClients.size > 0) {
          clearInterval(check);
          clearTimeout(timer);
          resolveDone();
        }
      }, 100);
    });
  }

  async function shutdown() {
    // Les flux SSE ouverts empêchent server.close() de finir : on les ferme,
    // le gestionnaire « close » de chaque requête fait le ménage dans les sets.
    for (const set of [store.uiClients, store.bridgeClients]) {
      for (const res of set) res.end();
      set.clear();
    }
    await stopPersona();
    store.mocks?.server.close();
    store.mocks = null;
  }

  // -------------------------------------------------- config + prompt réel
  function storedConfig() {
    try {
      return JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    } catch {
      return {};
    }
  }

  function effectivePrompt(incoming = "Salut, mon wifi coupe.") {
    // Le vrai prompt : un Agent réel sur la config courante, sans canal.
    const agent = new Agent(Config.load(), previewTransport());
    return agent.buildSystemPrompt(
      {
        contactId: "u_preview",
        contactName: "Correspondant studio",
        turns: [],
        turnCount: 0,
        escalated: false,
        firstSeenAt: 0,
        lastSeenAt: 0,
      },
      incoming,
    );
  }

  function previewTransport() {
    return {
      id: "studio-preview",
      capabilities: { voice: false, images: false, typing: false },
      async start() {},
      async stop() {},
      async sendText() {
        throw new Error("aperçu sans canal");
      },
      async sendVoice() {
        throw new Error("aperçu sans canal");
      },
      async sendImage() {
        throw new Error("aperçu sans canal");
      },
    };
  }

  // --------------------------------------------- export / import (fichier)
  /**
   * Export : une enveloppe versionnée sans aucun secret — le fichier est fait
   * pour être partagé, et les clés secrètes du schéma n'y entrent jamais.
   */
  function exportPersona() {
    const config = storedConfig();
    const schema = loadSchema();
    const exported = {};
    for (const [key, value] of Object.entries(config)) {
      if (schema[key]?.type === "secret") continue;
      exported[key] = value;
    }
    return {
      format: "snap-astreinte-persona",
      version: 1,
      exportedAt: new Date().toISOString(),
      name: String(config["persona.name"] ?? "").trim() || "persona",
      config: exported,
    };
  }

  /**
   * Import, deux formes :
   *  - l'enveloppe d'export → le fichier EST la persona : remise aux défauts
   *    du schéma puis application du fichier (recharger un persona partagé) ;
   *  - un objet plat de clés de config → simple patch (fusion).
   *
   * Dans les deux cas, les clés secrètes sont ignorées et signalées : un
   * fichier de config n'est pas l'endroit des secrets (cf. Config.save).
   */
  function importPersona(json, value) {
    const schema = loadSchema();
    const secrets = new Set(
      Object.entries(schema)
        .filter(([, f]) => f.type === "secret")
        .map(([k]) => k),
    );
    let patch;
    let replace = false;
    if (value && typeof value === "object" && !Array.isArray(value) && value.format !== undefined) {
      if (value.format !== "snap-astreinte-persona" || value.version !== 1) {
        return json(400, {
          error: "Format de fichier persona non reconnu (format/version). Utilisez un fichier produit par « Exporter ».",
        });
      }
      if (!value.config || typeof value.config !== "object" || Array.isArray(value.config)) {
        return json(400, { error: "Fichier persona sans section config." });
      }
      patch = value.config;
      replace = true;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      patch = value;
    } else {
      return json(400, { error: "Corps d'import absent ou invalide." });
    }

    const ignoredSecrets = [];
    for (const key of Object.keys(patch)) {
      if (secrets.has(key)) {
        ignoredSecrets.push(key);
        delete patch[key];
      }
    }

    if (replace) {
      // Le fichier remplace la persona : on repart des défauts du schéma.
      rmSync(join(home, "config.json"), { force: true });
    }
    const { unknownKeys } = Config.load().update(patch);
    const imported = Object.keys(patch).length - unknownKeys.length;
    return json(200, { imported, unknownKeys, ignoredSecrets, config: storedConfig() });
  }

  /** Personas d'exemple livrés avec l'extension (examples/personas/). */
  function examplesDir() {
    return join(ROOT, "examples", "personas");
  }

  function listPersonaExamples() {
    try {
      return readdirSync(examplesDir())
        .filter((f) => f.endsWith(".persona.json"))
        .sort()
        .map((file) => {
          try {
            const parsed = JSON.parse(readFileSync(join(examplesDir(), file), "utf8"));
            return {
              id: file.replace(/\.persona\.json$/, ""),
              file,
              name: String(parsed.name ?? file),
              description: describeExample(parsed.config ?? {}),
            };
          } catch {
            return null; // un exemple illisible ne bloque pas les autres
          }
        })
        .filter(Boolean);
    } catch {
      return []; // dossier absent : la section disparaît, rien ne casse
    }
  }

  /** Une phrase qui dit à quoi sert la persona, à partir de sa config. */
  function describeExample(config) {
    const style = String(config["persona.style"] ?? "").trim();
    const first = style.split(/[.!?]/)[0]?.trim() ?? "";
    return first.slice(0, 140);
  }

  /** Lit un exemple par identifiant, confiné au dossier des exemples. */
  function readPersonaExample(id) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null;
    const file = `${id}.persona.json`;
    const path = join(examplesDir(), file);
    if (!path.startsWith(examplesDir() + sep) || !existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  }

  // ------------------------------------------------- Morph (info réelle)
  function morphInfo() {
    const read = (p) => {
      try {
        return JSON.parse(readFileSync(p, "utf8"));
      } catch {
        return null;
      }
    };
    const manifest = read(join(ROOT, "plugin.json"));
    const mcp = read(join(ROOT, "mcp", "mcp.json"));
    const found = new Set();
    for (const match of JSON.stringify(mcp?.mcpServers ?? {}).matchAll(
      /\$\{([A-Za-z:][A-Za-z0-9:_]*)\}/g,
    )) {
      found.add(match[1]);
    }
    const supported = ["LOCARYN_PLUGIN_ROOT"];
    const locals = [...found].filter((v) => !v.startsWith("env:"));
    return {
      name: manifest?.name ?? null,
      version: manifest?.version ?? null,
      description: manifest?.description ?? null,
      settingsSections: (manifest?.ui_contributions?.settings_sections ?? []).map((s) => ({
        id: s.id,
        label: s.label,
        fields: s.fields?.length ?? 0,
      })),
      mcpVariables: [...found].sort(),
      supportedVariables: supported,
      mcpVariableWarning: locals.some((v) => !supported.includes(v)),
      installSteps: [
        "Locaryn → Réglages → Extensions → Ajouter",
        `Coller : ${ROOT}`,
        "Vérifier le manifeste, activer, accorder les permissions",
      ],
      paths: { root: ROOT, manifest: join(ROOT, "plugin.json"), mcp: join(ROOT, "mcp", "mcp.json") },
    };
  }

  // ------------------------------------------------- démon (vraie chaîne)
  function status() {
    return {
      running: Boolean(store.child),
      pid: store.child?.pid ?? null,
      llmMode: store.llmMode,
      bridge: bridgeUrl(),
      // « persona actif » est la ligne que le démon écrit une fois le canal
      // réellement ouvert (le contrat de start() garantit la main tendue).
      ready: store.log.some((l) => l.includes("persona actif")),
      lastStderr: store.log.slice(-4).join("\n").slice(-500),
    };
  }

  function startPersona(json, value) {
    if (store.child) return json(200, status());
    if (!existsSync(ENTRY)) return json(500, { error: "dist/ absent — lancer npm run build." });
    const llmMode = value?.llmMode === "local" ? "local" : "mock";

    let llmBase = "http://127.0.0.1:8080/v1";
    let ttsUrl = "http://127.0.0.1:8080/v1/audio/speech";
    if (llmMode === "mock") {
      // synchrone : ensureMocks est résolu avant la création du banc ? Non —
      // la route est async côté appelant, on attend le port ici via .then
      // n'est pas possible : startPersona est appelé dans handle (async).
    }
    return ensureMocks(llmMode === "mock").then((port) => {
      if (llmMode === "mock") {
        llmBase = `http://127.0.0.1:${port}/mock/v1`;
        ttsUrl = `${llmBase}/audio/speech`;
      }

      // Les surcharges de transport passent par la vraie classe Config : le
      // démon lira exactement ce fichier (même SNAP_ASTREINTE_HOME).
      Config.load().update({
        "transport.driver": "bridge",
        "transport.bridge_url": bridgeUrl(),
        "llm.base_url": llmBase,
        "llm.model": "studio",
        "voice.tts_mode": "http",
        "voice.tts_url": ttsUrl,
        "image.mode": "on_request",
        "image.engine": "http",
        "image.base_url": llmBase,
      });

      const child = spawn(process.execPath, [ENTRY, "daemon"], {
        cwd: ROOT,
        env: { ...process.env, SNAP_ASTREINTE_HOME: home },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      store.child = child;
      store.llmMode = llmMode;
      child.stderr.on("data", (d) => {
        for (const line of String(d).split(/\r?\n/)) {
          if (line.trim()) {
            store.log.push(line);
            if (store.log.length > 300) store.log.splice(0, store.log.length - 300);
          }
        }
      });
      child.on("exit", (code) => {
        store.log.push(`[studio] démon arrêté (code ${code ?? "?"})`);
        if (store.child === child) {
          store.child = null;
          store.llmMode = null;
        }
      });
      return json(202, status());
    });
  }

  async function stopPersona() {
    const child = store.child;
    if (!child) return;
    if (child.exitCode != null) {
      store.child = null;
      return;
    }
    child.kill();
    await new Promise((done) => {
      const timer = setTimeout(done, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        done();
      });
    });
  }

  // ------------------------------------------------- serveurs factices
  /** LLM + TTS + image, formats OpenAI réels, port éphémère. */
  function ensureMocks(wanted) {
    if (!wanted) return Promise.resolve(0);
    if (store.mocks) return Promise.resolve(store.mocks.port);
    return new Promise((resolveDone, rejectDone) => {
      const server = createServer((req, res) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          let body = {};
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          } catch {
            // Requête malformée : traitée comme vide.
          }
          const done = (status, payload, type = "application/json") => {
            res.writeHead(status, { "content-type": type });
            res.end(payload);
          };
          const p = (req.url ?? "").split("?")[0];
          if (p.endsWith("/chat/completions")) return done(200, mockChat(body));
          if (p.endsWith("/audio/speech")) return done(200, mockWav(), "audio/wav");
          if (p.endsWith("/images/generations")) {
            return done(200, JSON.stringify({ data: [{ b64_json: mockPng().toString("base64") }] }));
          }
          return done(404, JSON.stringify({ error: `mock : route inconnue ${p}` }));
        });
      });
      server.on("error", rejectDone);
      server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        store.mocks = { server, port };
        resolveDone(port);
      });
    });
  }

  /**
   * Réponse du LLM simulé. Le prompt système est le VRAI prompt du persona :
   * quand il contient la directive IMAGE:, l'Agent a déjà validé que le
   * message demande une image — on produit alors le marqueur attendu, sinon
   * une réponse courte qui prouve que nom et style sont bien arrivés.
   */
  function mockChat(body) {
    const msgs = Array.isArray(body?.messages) ? body.messages : [];
    const system = String(msgs.find((m) => m?.role === "system")?.content ?? "");
    const user = String([...msgs].reverse().find((m) => m?.role === "user")?.content ?? "");
    const name = system.match(/Tu t'appelles ([^.]+)\./)?.[1] ?? "l'assistant";
    const content = system.includes("IMAGE:")
      ? "IMAGE: a simple colorful test illustration of a cat, flat vector style\n\nTiens, voila ton image !"
      : `Bien recu, ${name} ici. Tu me dis : « ${user.slice(0, 120)} ». Je m'en occupe et je te redis.`;
    return JSON.stringify({ choices: [{ message: { role: "assistant", content } }] });
  }

  /**
   * Petit PNG « réel » : un dégradé vertical sur une rangée de couleurs.
   * Un PNG 1×1 ferait moins de 128 octets — ImageGen le jugerait vide (seuil
   * anti-serveurs-cassés) et replacerait la réponse en texte.
   */
  function mockPng() {
    const width = 100;
    const height = 100;
    const raw = Buffer.alloc((width * 3 + 1) * height);
    const palette = [
      [74, 124, 89],
      [107, 158, 124],
      [150, 190, 160],
      [200, 220, 200],
    ];
    for (let y = 0; y < height; y += 1) {
      const rowStart = y * (width * 3 + 1);
      raw[rowStart] = 0; // filtre « none »
      const c1 = palette[Math.floor(y / 25) % palette.length];
      const c2 = palette[(Math.floor(y / 25) + 1) % palette.length];
      for (let x = 0; x < width; x += 1) {
        const t = x / width;
        const i = rowStart + 1 + x * 3;
        raw[i] = Math.round(c1[0] + (c2[0] - c1[0]) * t);
        raw[i + 1] = Math.round(c1[1] + (c2[1] - c1[1]) * t);
        raw[i + 2] = Math.round(c1[2] + (c2[2] - c1[2]) * t);
      }
    }
    const idat = deflateSync(raw);
    const crcTable = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    const crcOf = (buf) => {
      let c = 0xffffffff;
      for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // profondeur
    ihdr[9] = 2; // couleur truecolor
    const pngChunk = (type, data) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length, 0);
      const typeBuf = Buffer.from(type, "ascii");
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crcOf(Buffer.concat([typeBuf, data])), 0);
      return Buffer.concat([len, typeBuf, data, crc]);
    };
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", ihdr),
      pngChunk("IDAT", idat),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
  }

  /** Petit WAV valide (RIFF/PCM 8 kHz mono, 160 échantillons de silence). */
  function mockWav() {
    const samples = Buffer.alloc(160 * 2);
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + samples.length, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(8000, 24);
    header.writeUInt32LE(16000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(samples.length, 40);
    return Buffer.concat([header, samples]);
  }

  // ------------------------------------------------- journal conversation
  function record(entry) {
    store.history.push(entry);
    if (store.history.length > 400) store.history.splice(0, store.history.length - 400);
    broadcast(store.uiClients, entry);
  }

  function broadcast(clients, payload) {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) client.write(data);
  }
}

/** Lit un corps JSON, tolérant ({} si absent ou malformé). */
async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}
