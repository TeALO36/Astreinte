/**
 * Driver Telegram.
 *
 * Long polling plutôt que webhook : aucune adresse publique à exposer, aucun
 * certificat, l'extension tourne derrière n'importe quelle box. `getUpdates`
 * bloque côté serveur jusqu'à 25 s, donc la latence reste faible sans marteler
 * l'API.
 *
 * `sendVoice` demande de l'OGG/Opus pour afficher une vraie note vocale avec sa
 * forme d'onde ; un WAV passerait en pièce jointe. On convertit via ffmpeg
 * quand il est là, et on le dit clairement quand il ne l'est pas.
 */
import { spawn } from "node:child_process";
import { TransportError } from "./types.js";
const API = "https://api.telegram.org";
export class TelegramTransport {
    token;
    pollIntervalMs;
    id = "telegram";
    capabilities = { voice: true, typing: true };
    offset = 0;
    running = false;
    loop = null;
    constructor(token, pollIntervalMs = 2000) {
        this.token = token;
        this.pollIntervalMs = pollIntervalMs;
        if (!token.trim()) {
            throw new TransportError("jeton Telegram absent. Renseignez-le dans la configuration de l'extension, ou via la variable SNAP_ASTREINTE_TELEGRAM_TOKEN.");
        }
    }
    url(method) {
        return `${API}/bot${this.token}/${method}`;
    }
    async call(method, payload) {
        const res = await fetch(this.url(method), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const body = (await res.json().catch(() => ({})));
        if (!res.ok || !body.ok) {
            throw new TransportError(`Telegram ${method} : ${body.description ?? res.status}`);
        }
        return body.result;
    }
    /** Vérifie le jeton au démarrage : un jeton faux doit se voir tout de suite. */
    async whoami() {
        const me = await this.call("getMe", {});
        return me.username ? `@${me.username}` : "bot";
    }
    async start(handler) {
        const who = await this.whoami();
        console.error(`[snap-astreinte] Telegram connecté : ${who}`);
        this.running = true;
        this.loop = this.pump(handler);
    }
    async pump(handler) {
        while (this.running) {
            try {
                const updates = await this.call("getUpdates", {
                    offset: this.offset,
                    timeout: 25,
                    allowed_updates: ["message"],
                });
                for (const update of updates) {
                    // L'offset avance même si le traitement échoue : sinon un message
                    // qui fait planter le handler serait rejoué en boucle sans fin.
                    this.offset = Math.max(this.offset, update.update_id + 1);
                    const msg = update.message;
                    if (!msg)
                        continue;
                    const text = msg.text ?? msg.caption ?? "";
                    const isVoice = !!msg.voice;
                    // Un vocal sans transcription n'a pas de texte exploitable : on le
                    // signale plutôt que de laisser le modèle répondre à du vide.
                    if (!text && !isVoice)
                        continue;
                    const name = msg.from?.first_name ?? msg.chat.first_name ?? msg.from?.username ?? msg.chat.username;
                    try {
                        await handler({
                            contactId: String(msg.chat.id),
                            contactName: name,
                            text,
                            isVoice,
                            receivedAt: msg.date * 1000,
                        });
                    }
                    catch (e) {
                        console.error(`[snap-astreinte] traitement du message échoué : ${e.message}`);
                    }
                }
            }
            catch (e) {
                console.error(`[snap-astreinte] relève Telegram : ${e.message}`);
                await sleep(Math.max(this.pollIntervalMs, 3000));
            }
        }
    }
    async stop() {
        this.running = false;
        await this.loop?.catch(() => undefined);
        this.loop = null;
    }
    async sendText(contactId, text) {
        // Telegram refuse au-delà de 4096 caractères : on découpe plutôt que de
        // laisser l'API rejeter tout le message.
        for (const chunk of chunkText(text, 4000)) {
            await this.call("sendMessage", { chat_id: contactId, text: chunk });
        }
    }
    async sendVoice(contactId, audio, mimeType) {
        let payload = audio;
        let filename = "note.ogg";
        if (!mimeType.includes("ogg") && !mimeType.includes("opus")) {
            const converted = await toOpus(audio).catch(() => null);
            if (!converted) {
                throw new TransportError("Telegram attend de l'OGG/Opus pour une note vocale, et ffmpeg est introuvable pour convertir. " +
                    "Installez ffmpeg, ou configurez un moteur TTS qui produit directement de l'OGG.");
            }
            payload = converted;
        }
        const form = new FormData();
        form.append("chat_id", contactId);
        form.append("voice", new Blob([new Uint8Array(payload)], { type: "audio/ogg" }), filename);
        const res = await fetch(this.url("sendVoice"), { method: "POST", body: form });
        const body = (await res.json().catch(() => ({})));
        if (!res.ok || !body.ok) {
            throw new TransportError(`Telegram sendVoice : ${body.description ?? res.status}`);
        }
    }
    async setTyping(contactId, on) {
        if (!on)
            return;
        await this.call("sendChatAction", { chat_id: contactId, action: "record_voice" }).catch(() => undefined);
    }
}
/** Convertit vers OGG/Opus via ffmpeg. Rejette si ffmpeg est absent. */
function toOpus(input) {
    return new Promise((resolveDone, rejectDone) => {
        const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-c:a", "libopus", "-b:a", "32k", "-f", "ogg", "pipe:1"], { windowsHide: true });
        const chunks = [];
        child.stdout.on("data", (d) => chunks.push(d));
        child.on("error", rejectDone);
        child.on("close", (code) => {
            if (code === 0 && chunks.length)
                resolveDone(Buffer.concat(chunks));
            else
                rejectDone(new Error(`ffmpeg code ${code}`));
        });
        child.stdin.on("error", () => undefined);
        child.stdin.end(input);
    });
}
export function chunkText(text, size) {
    if (text.length <= size)
        return [text];
    const out = [];
    let rest = text;
    while (rest.length > size) {
        const window = rest.slice(0, size);
        // Coupe sur un saut de ligne ou une fin de phrase quand c'est possible,
        // pour ne pas trancher un mot en deux entre deux messages.
        const at = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(". "));
        const cut = at > size * 0.5 ? at + 1 : size;
        out.push(rest.slice(0, cut).trimEnd());
        rest = rest.slice(cut).trimStart();
    }
    if (rest)
        out.push(rest);
    return out;
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
//# sourceMappingURL=telegram.js.map