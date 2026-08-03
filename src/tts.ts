/**
 * Notes vocales.
 *
 * Deux moteurs, parce qu'aucun n'est universel :
 *
 *  - **http** : un serveur exposant `/v1/audio/speech` (convention OpenAI, que
 *    la plupart des serveurs TTS locaux reprennent). Le clonage de voix passe
 *    par le champ `voice`, dont la signification dépend du serveur.
 *  - **command** : une ligne de commande locale. C'est la voie pour les moteurs
 *    qui clonent à partir d'un échantillon (XTTS, Qwen3-TTS, OpenVoice) et qui
 *    n'exposent pas d'API HTTP. `{ref}` reçoit le fichier de référence.
 *
 * Aucun des deux n'est supposé présent : si la synthèse échoue, l'appelant
 * bascule en texte plutôt que de laisser tomber le message.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.js";

export class TtsError extends Error {}

export interface VoiceClip {
  audio: Buffer;
  /** Type MIME réel, pour que le transport choisisse le bon envoi. */
  mimeType: string;
}

/** Découpe une ligne de commande en respectant les guillemets. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out;
}

export class Tts {
  constructor(private cfg: Config) {}

  get mode(): string {
    return this.cfg.str("voice.tts_mode") || "disabled";
  }

  get available(): boolean {
    if (this.mode === "disabled") return false;
    if (this.mode === "http") return !!this.cfg.str("voice.tts_url").trim();
    return !!this.cfg.str("voice.tts_command").trim();
  }

  /** Le texte est-il synthétisable au vu des limites configurées ? */
  fits(text: string): boolean {
    const max = this.cfg.num("voice.max_chars");
    return max <= 0 || text.length <= max;
  }

  async synthesize(text: string): Promise<VoiceClip> {
    if (!this.available) throw new TtsError("aucun moteur de synthèse configuré");
    return this.mode === "http" ? this.viaHttp(text) : this.viaCommand(text);
  }

  private async viaHttp(text: string): Promise<VoiceClip> {
    const url = this.cfg.str("voice.tts_url").trim();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.cfg.str("voice.tts_model") || undefined,
          voice: this.cfg.str("voice.tts_voice") || undefined,
          input: text,
          response_format: "wav",
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new TtsError(`TTS ${res.status} : ${detail.slice(0, 200)}`);
      }
      const audio = Buffer.from(await res.arrayBuffer());
      if (audio.length < 64) throw new TtsError("le serveur TTS a renvoyé un fichier vide");
      const mimeType = res.headers.get("content-type")?.split(";")[0]?.trim() || "audio/wav";
      return { audio, mimeType };
    } catch (e) {
      if (e instanceof TtsError) throw e;
      if ((e as Error).name === "AbortError") throw new TtsError("le serveur TTS n'a pas répondu à temps");
      throw new TtsError(`${(e as Error).message} (${url})`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async viaCommand(text: string): Promise<VoiceClip> {
    const template = this.cfg.str("voice.tts_command").trim();
    const dir = mkdtempSync(join(tmpdir(), "snap-astreinte-tts-"));
    const out = join(dir, "note.wav");
    const ref = this.cfg.str("voice.reference_sample").trim();

    try {
      // Le texte passe par stdin quand le gabarit ne contient pas {text} :
      // c'est le cas de Piper, et cela évite les limites de longueur de ligne
      // de commande sous Windows.
      const usesStdin = !template.includes("{text}");
      const parts = splitCommand(
        template.replaceAll("{out}", out).replaceAll("{ref}", ref).replaceAll("{text}", text),
      );
      const bin = parts[0];
      if (!bin) throw new TtsError("commande TTS vide");

      await new Promise<void>((resolveDone, rejectDone) => {
        const child = spawn(bin, parts.slice(1), { windowsHide: true });
        let stderr = "";
        child.stderr.on("data", (d) => {
          stderr += String(d);
        });
        child.on("error", (err) => rejectDone(new TtsError(`${bin} : ${err.message}`)));
        child.on("close", (code) => {
          if (code === 0) resolveDone();
          else rejectDone(new TtsError(`${bin} a terminé avec le code ${code} : ${stderr.slice(-300)}`));
        });
        if (usesStdin) {
          child.stdin.write(text);
          child.stdin.end();
        }
      });

      if (!existsSync(out)) throw new TtsError(`la commande n'a produit aucun fichier (${out})`);
      const audio = readFileSync(out);
      if (audio.length < 64) throw new TtsError("le fichier audio produit est vide");
      return { audio, mimeType: "audio/wav" };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/**
 * L'interlocuteur demande-t-il explicitement un vocal ?
 *
 * Volontairement conservateur : le coût d'un faux positif (un vocal non
 * souhaité) est plus élevé que celui d'un faux négatif (du texte alors qu'on
 * voulait de la voix, et il suffit de redemander).
 */
export function asksForVoice(text: string): boolean {
  const t = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const patterns = [
    /\bvocal\b/,
    /\bvocaux\b/,
    /message audio\b/,
    /\ben audio\b/,
    /\ba l'oral\b/,
    /\boralement\b/,
    /\b(dis|explique|raconte)[- ]le?[- ]moi (de vive voix|a l'oral)\b/,
    /\bvoice note\b/,
    /\bvoice message\b/,
  ];
  return patterns.some((p) => p.test(t));
}
