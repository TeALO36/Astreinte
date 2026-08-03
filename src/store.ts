/**
 * Contextes par interlocuteur.
 *
 * C'est la pièce qui fait que deux personnes écrivant en même temps ne se
 * mélangent jamais. Deux garanties :
 *
 *  1. **Isolation** — un fichier et un contexte par contact, jamais d'historique
 *     partagé. La clé est l'identifiant que le canal donne à l'interlocuteur.
 *  2. **Sérialisation par contact** — un verrou par contact met en file les
 *     traitements d'un même interlocuteur. Sans lui, deux messages rapprochés
 *     de la même personne liraient tous deux le contexte avant que l'un ait
 *     écrit le sien, et le premier tour serait perdu. Node est mono-thread mais
 *     chaque `await` est un point d'entrelacement, donc le risque est réel.
 *
 * Les contacts différents ne se bloquent pas entre eux : deux demandes
 * simultanées de deux personnes sont traitées en parallèle.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { astreinteHome } from "./config.js";
import type { ContactContext, Turn } from "./types.js";

function contactsDir(): string {
  return join(astreinteHome(), "contacts");
}

/** Nom de fichier sûr et stable, quel que soit ce que le canal fournit. */
function fileFor(contactId: string): string {
  const hash = createHash("sha256").update(contactId).digest("hex").slice(0, 16);
  const readable = contactId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  return join(contactsDir(), `${readable || "contact"}-${hash}.json`);
}

function emptyContext(contactId: string, contactName?: string): ContactContext {
  const now = Date.now();
  return {
    contactId,
    contactName,
    turns: [],
    turnCount: 0,
    escalated: false,
    firstSeenAt: now,
    lastSeenAt: now,
  };
}

export class ContactStore {
  /** Une chaîne de promesses par contact : le verrou. */
  private locks = new Map<string, Promise<unknown>>();
  private cache = new Map<string, ContactContext>();

  constructor(private maxTurns: number) {}

  /**
   * Exécute `fn` avec un accès exclusif au contexte de ce contact, et persiste
   * ce que `fn` a modifié. Les appels concurrents sur le MÊME contact
   * s'exécutent l'un après l'autre ; sur des contacts différents, en parallèle.
   */
  async withContact<T>(
    contactId: string,
    contactName: string | undefined,
    fn: (ctx: ContactContext) => Promise<T> | T,
  ): Promise<T> {
    const previous = this.locks.get(contactId) ?? Promise.resolve();

    // `catch` sur le prédécesseur : un traitement qui échoue ne doit pas
    // bloquer indéfiniment la file de ce contact.
    const run = previous.catch(() => undefined).then(async () => {
      const ctx = this.read(contactId, contactName);
      if (contactName && ctx.contactName !== contactName) ctx.contactName = contactName;
      ctx.lastSeenAt = Date.now();
      try {
        return await fn(ctx);
      } finally {
        this.trim(ctx);
        this.write(ctx);
      }
    });

    this.locks.set(contactId, run);
    return run;
  }

  read(contactId: string, contactName?: string): ContactContext {
    const cached = this.cache.get(contactId);
    if (cached) return cached;

    const path = fileFor(contactId);
    let ctx: ContactContext;
    if (existsSync(path)) {
      try {
        ctx = JSON.parse(readFileSync(path, "utf8")) as ContactContext;
        ctx.turns ??= [];
        ctx.turnCount ??= ctx.turns.length;
      } catch {
        ctx = emptyContext(contactId, contactName);
      }
    } else {
      ctx = emptyContext(contactId, contactName);
    }
    this.cache.set(contactId, ctx);
    return ctx;
  }

  private write(ctx: ContactContext): void {
    mkdirSync(contactsDir(), { recursive: true });
    writeFileSync(fileFor(ctx.contactId), JSON.stringify(ctx, null, 2), "utf8");
    this.cache.set(ctx.contactId, ctx);
  }

  /**
   * Garde les `maxTurns` derniers tours. Les plus anciens sont repliés dans un
   * résumé textuel plutôt que jetés, pour qu'un dépannage long garde sa trace.
   */
  private trim(ctx: ContactContext): void {
    if (ctx.turns.length <= this.maxTurns) return;
    const overflow = ctx.turns.splice(0, ctx.turns.length - this.maxTurns);
    const digest = overflow
      .map((t) => `${t.role === "user" ? "Lui" : "Moi"} : ${t.content.replace(/\s+/g, " ").slice(0, 180)}`)
      .join("\n");
    ctx.summary = ctx.summary ? `${ctx.summary}\n${digest}` : digest;
    // Le résumé lui-même est borné, sinon il grossit sans fin.
    if (ctx.summary.length > 4000) ctx.summary = ctx.summary.slice(-4000);
  }

  addTurn(ctx: ContactContext, role: Turn["role"], content: string): void {
    ctx.turns.push({ role, content, at: Date.now() });
    if (role === "user") ctx.turnCount += 1;
  }

  /** Remet le compteur de tours et lève l'escalade : nouvelle demande. */
  reset(ctx: ContactContext): void {
    ctx.turnCount = 0;
    ctx.escalated = false;
    delete ctx.escalatedReason;
  }

  list(): ContactContext[] {
    const dir = contactsDir();
    if (!existsSync(dir)) return [];
    const out: ContactContext[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as ContactContext);
      } catch {
        // Un fichier corrompu ne doit pas masquer tous les autres.
      }
    }
    return out.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  forget(contactId: string): boolean {
    this.cache.delete(contactId);
    const path = fileFor(contactId);
    if (!existsSync(path)) return false;
    rmSync(path);
    return true;
  }

  /** Supprime les contextes inactifs depuis plus de `days` jours. 0 = jamais. */
  purge(days: number): number {
    if (days <= 0) return 0;
    const cutoff = Date.now() - days * 86_400_000;
    let removed = 0;
    for (const ctx of this.list()) {
      if (ctx.lastSeenAt < cutoff) {
        if (this.forget(ctx.contactId)) removed += 1;
      }
    }
    return removed;
  }
}
