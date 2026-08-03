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
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const home = mkdtempSync(join(tmpdir(), "snap-astreinte-e2e-"));
process.env.SNAP_ASTREINTE_HOME = home;
const { Agent } = await import("./agent.js");
const { Config } = await import("./config.js");
const { BridgeTransport } = await import("./transports/bridge.js");
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
/** Pont factice : diffuse les messages qu'on lui pousse, collecte les envois. */
class FakeBridge {
    voiceCapable;
    sent = [];
    clients = [];
    server;
    port = 0;
    constructor(voiceCapable = false) {
        this.voiceCapable = voiceCapable;
        this.server = createServer((req, res) => {
            const url = req.url ?? "";
            if (url === "/health") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, voice: this.voiceCapable, detail: "pont de test" }));
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
            if (url === "/send" || url === "/sendVoice") {
                let body = "";
                req.on("data", (c) => (body += c));
                req.on("end", () => {
                    const parsed = JSON.parse(body || "{}");
                    this.sent.push({
                        contactId: parsed.contactId,
                        text: parsed.text,
                        voice: url === "/sendVoice",
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
    async listen() {
        await new Promise((r) => this.server.listen(0, "127.0.0.1", r));
        this.port = this.server.address().port;
        return `http://127.0.0.1:${this.port}`;
    }
    /** Simule l'arrivée d'un message côté canal. */
    push(msg) {
        const payload = `data: ${JSON.stringify(msg)}\n\n`;
        for (const c of this.clients)
            c.write(payload);
    }
    async close() {
        for (const c of this.clients)
            c.end();
        await new Promise((r) => this.server.close(() => r()));
    }
}
/** Modèle factice : répond en reprenant le dernier message, pour tracer l'origine. */
class FakeLlm {
    delayMs;
    seen = [];
    server;
    constructor(delayMs = 0) {
        this.delayMs = delayMs;
        this.server = createServer((req, res) => {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                const parsed = JSON.parse(body || "{}");
                const system = parsed.messages.find((m) => m.role === "system")?.content ?? "";
                const lastUser = [...parsed.messages].reverse().find((m) => m.role === "user")?.content ?? "";
                this.seen.push({ system, lastUser });
                setTimeout(() => {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({
                        choices: [{ message: { content: `réponse à « ${lastUser} »` } }],
                    }));
                }, this.delayMs);
            });
        });
    }
    async listen() {
        await new Promise((r) => this.server.listen(0, "127.0.0.1", r));
        return `http://127.0.0.1:${this.server.address().port}/v1`;
    }
    async close() {
        await new Promise((r) => this.server.close(() => r()));
    }
}
const waitFor = async (fn, ms = 5000) => {
    const started = Date.now();
    while (!fn()) {
        if (Date.now() - started > ms)
            throw new Error("délai dépassé");
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
    assert.match(toAlice.text ?? "", /imprimante/, "Alice ne doit pas recevoir le sujet de Bob");
    assert.match(toBob.text ?? "", /écran bleu/, "Bob ne doit pas recevoir le sujet d'Alice");
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
    const log = agent.recentLog();
    assert.ok(log.at(-1)?.error, "l'échec doit être tracé dans le journal");
    await transport.stop();
    await bridge.close();
});
//# sourceMappingURL=e2e.test.js.map