/**
 * Images générées pour le persona.
 *
 * Deux moteurs, comme pour les notes vocales :
 *
 *  - **http** : un serveur exposant `/v1/images/generations` (convention
 *    OpenAI, reprise par la plupart des serveurs d'image locaux).
 *  - **command** : une ligne de commande locale (un script Stable Diffusion,
 *    ComfyUI en CLI, etc.). `{prompt}` reçoit le prompt, `{out}` le fichier à
 *    produire ; sans `{prompt}`, le prompt passe par stdin.
 *
 * Aucun des deux n'est supposé présent : si la génération échoue, l'appelant
 * retombe sur la réponse texte plutôt que de laisser tomber le message.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.js";

export class ImageError extends Error {}

export interface GeneratedImage {
  image: Buffer;
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

export class ImageGen {
  constructor(private cfg: Config) {}

  get mode(): string {
    return this.cfg.str("image.mode") || "on_request";
  }

  /** Le moteur est-il configuré et prêt à produire une image ? */
  get available(): boolean {
    const engine = this.cfg.str("image.engine") || "http";
    if (engine === "command") return !!this.cfg.str("image.command").trim();
    return !!this.cfg.str("image.base_url").trim();
  }

  async generate(prompt: string): Promise<GeneratedImage> {
    if (!this.available) throw new ImageError("aucun moteur d'image configuré");
    const engine = this.cfg.str("image.engine") || "http";
    return engine === "command" ? this.viaCommand(prompt) : this.viaHttp(prompt);
  }

  private async viaHttp(prompt: string): Promise<GeneratedImage> {
    const url = this.cfg.str("image.base_url").trim().replace(/\/+$/, "") + "/images/generations";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180_000);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const apiKey = this.cfg.str("image.api_key").trim();
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      const res = await fetch(url, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: this.cfg.str("image.model") || undefined,
          prompt,
          n: 1,
          size: this.cfg.str("image.size") || "1024x1024",
          response_format: "b64_json",
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new ImageError(`image ${res.status} : ${detail.slice(0, 200)}`);
      }

      const body = (await res.json()) as {
        data?: Array<{ b64_json?: string; url?: string }>;
      };
      const item = body.data?.[0];
      if (!item) throw new ImageError("le serveur d'images n'a rien renvoyé");

      if (item.b64_json) {
        const image = Buffer.from(item.b64_json, "base64");
        if (image.length < 128) throw new ImageError("l'image renvoyée est vide");
        return { image, mimeType: "image/png" };
      }
      if (item.url) {
        const img = await fetch(item.url, { signal: controller.signal });
        if (!img.ok) throw new ImageError(`téléchargement de l'image refusé (${img.status})`);
        const image = Buffer.from(await img.arrayBuffer());
        const mimeType =
          img.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
        return { image, mimeType };
      }
      throw new ImageError("le serveur d'images n'a renvoyé ni b64_json ni url");
    } catch (e) {
      if (e instanceof ImageError) throw e;
      if ((e as Error).name === "AbortError") {
        throw new ImageError("le serveur d'images n'a pas répondu à temps");
      }
      throw new ImageError(`${(e as Error).message} (${url})`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async viaCommand(prompt: string): Promise<GeneratedImage> {
    const template = this.cfg.str("image.command").trim();
    const dir = mkdtempSync(join(tmpdir(), "snap-astreinte-image-"));
    const out = join(dir, "image.png");

    try {
      const usesStdin = !template.includes("{prompt}");
      const parts = splitCommand(
        template.replaceAll("{out}", out).replaceAll("{prompt}", prompt),
      );
      const bin = parts[0];
      if (!bin) throw new ImageError("commande d'image vide");

      await new Promise<void>((resolveDone, rejectDone) => {
        const child = spawn(bin, parts.slice(1), { windowsHide: true });
        let stderr = "";
        child.stderr.on("data", (d) => {
          stderr += String(d);
        });
        child.on("error", (err) => rejectDone(new ImageError(`${bin} : ${err.message}`)));
        child.on("close", (code) => {
          if (code === 0) resolveDone();
          else
            rejectDone(
              new ImageError(`${bin} a terminé avec le code ${code} : ${stderr.slice(-300)}`),
            );
        });
        if (usesStdin) {
          child.stdin.write(prompt);
          child.stdin.end();
        }
      });

      if (!existsSync(out)) throw new ImageError(`la commande n'a produit aucun fichier (${out})`);
      const image = readFileSync(out);
      if (image.length < 128) throw new ImageError("le fichier image produit est vide");
      return { image, mimeType: "image/png" };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/**
 * L'interlocuteur demande-t-il une image ?
 *
 * Volontairement conservateur, comme pour le vocal : un faux positif (une
 * image non souhaitée) coûte plus cher qu'un faux négatif (du texte alors
 * qu'on voulait une image — il suffit de redemander).
 */
export function asksForImage(text: string): boolean {
  const t = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const patterns = [
    // verbe d'action → article → nom d'image
    /(?:genere|créer|crée|creer|dessine|dessiner|produis|envoie|envoies|montre|montres|fais|veux|voudrais|aimerais|souhaite|il me faut)[^.!?\n]{0,90}(?:une|un|des|de la|de l|d une|d un|deux|quelques)[^.!?\n]{0,40}(?:image|photo|illustration|dessin|logo|banniere|affiche|visuel|croquis|portrait|meme|schema|picture|drawing|artwork)/,
    // même chose en anglais
    /(?:generate|create|make|draw|send|show|want|would like)[^.!?\n]{0,90}(?:an?|the|a|some)[^.!?\n]{0,40}(?:image|picture|photo|illustration|drawing|logo|banner|meme|artwork)/,
    // impératif court : « envoie-moi une photo… »
    /(?:envoie|montre|genere|crée|creer|dessine|fais)[ -]moi[^.!?\n]{0,60}(?:une|un|des)?\s*(?:image|photo|illustration|dessin|logo|banniere|affiche|picture|meme)/,
    // nom d'image + de/du + politesse : « une photo de chat stp »
    /(?:image|photo|picture|illustration|dessin|logo|meme|banniere|affiche)[^.!?\n]{0,50}(?:de|d|of|pour)[^.!?\n]{0,70}(?:s il te plait|stp|svp|merci|please|si possible|pour moi)/,
  ];
  return patterns.some((p) => p.test(t));
}

/**
 * Extrait la demande d'image d'une réponse du modèle.
 *
 * Le persona est invité, quand une image est demandée, à commencer sa réponse
 * par `IMAGE:` suivi du prompt de génération. Renvoie le prompt et le texte
 * qui suit le marqueur (à utiliser comme légende ou comme réponse texte).
 */
export function extractImageRequest(
  reply: string,
): { prompt: string; textAfter: string } | null {
  const m = /^IMAGE:\s*([^\n]+)([\s\S]*)$/im.exec(reply.trim());
  if (!m) return null;
  const prompt = m[1]!.trim();
  // Un prompt déraisonnablement long est probablement une réponse texte
  // accidentellement préfixée : on n'envoie pas n'importe quoi au moteur.
  if (!prompt || prompt.length > 1500) return null;
  return { prompt, textAfter: m[2]!.trim() };
}
