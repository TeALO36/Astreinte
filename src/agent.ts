/**
 * Le cœur : ce qui se passe entre « un message arrive » et « une réponse part ».
 *
 * Ordre volontaire à chaque message :
 *
 *   verrou du contact → politique → modèle → longueur → voix ou texte → envoi
 *
 * La politique passe **avant** le modèle : lui demander après coup s'il avait
 * le droit de répondre revient à lui confier la garde de sa propre limite.
 * Le verrou est pris en premier pour que deux messages d'une même personne ne
 * lisent pas le même contexte en parallèle ; deux personnes différentes, elles,
 * sont traitées simultanément.
 */

import { Config } from "./config.js";
import { ImageGen, ImageError, asksForImage, extractImageRequest } from "./image.js";
import { Llm, LlmError, type ChatMessage } from "./llm.js";
import { Notifier } from "./notifier.js";
import { Policy } from "./policy.js";
import { ContactStore } from "./store.js";
import { Tts, TtsError, asksForVoice } from "./tts.js";
import type { Transport } from "./transports/types.js";
import type { ContactContext, IncomingMessage, LogEntry } from "./types.js";

const MAX_LOG = 200;

export class Agent {
  readonly store: ContactStore;
  readonly policy: Policy;
  readonly tts: Tts;
  readonly imageGen: ImageGen;
  private llm: Llm;
  private notifier: Notifier;
  private log: LogEntry[] = [];

  constructor(
    private cfg: Config,
    private transport: Transport,
  ) {
    this.store = new ContactStore(cfg.num("context.max_history_turns") || 20);
    this.policy = new Policy(cfg);
    this.tts = new Tts(cfg);
    this.imageGen = new ImageGen(cfg);
    this.notifier = new Notifier(cfg);
    this.llm = new Llm({
      baseUrl: cfg.str("llm.base_url"),
      model: cfg.str("llm.model"),
      apiKey: cfg.str("llm.api_key") || undefined,
      temperature: cfg.num("llm.temperature"),
      timeoutMs: cfg.num("llm.timeout_ms") || 120_000,
    });
  }

  recentLog(limit = 50): LogEntry[] {
    return this.log.slice(-limit);
  }

  /**
   * Une demande d'image peut-elle être traitée ici ? Le mode doit le permettre,
   * le canal doit savoir envoyer une photo, et un moteur d'image doit être
   * configuré — sinon la directive IMAGE: n'entre jamais dans le prompt, et le
   * modèle ne s'embarque pas dans une promesse qu'on ne pourrait pas tenir.
   */
  private canSendImage(incomingText: string): boolean {
    return (
      this.cfg.str("image.mode") !== "never" &&
      this.transport.capabilities.images &&
      this.imageGen.available &&
      asksForImage(incomingText)
    );
  }

  /** Instructions système, reconstruites à chaque message : la config peut bouger. */
  buildSystemPrompt(ctx: ContactContext, incomingText = ""): string {
    const parts: string[] = [];

    const style = this.cfg.str("persona.style").trim();
    parts.push(style || "Tu réponds à des demandes d'aide informatique, avec clarté et concision.");

    const name = this.cfg.str("persona.name").trim();
    if (name) parts.push(`Tu t'appelles ${name}.`);

    const lang = this.cfg.str("persona.language");
    if (lang === "fr") parts.push("Réponds toujours en français.");
    else if (lang === "en") parts.push("Always answer in English.");
    else parts.push("Réponds dans la langue du message que tu reçois.");

    if (this.cfg.bool("persona.disclose_ai")) {
      parts.push(
        "Si on te demande si tu es un humain, un robot ou une IA, réponds honnêtement que tu es un assistant automatique. Ne prétends jamais être une personne.",
      );
    }

    const limits = this.policy.promptFragment();
    if (limits) parts.push(limits);

    if (ctx.contactName) parts.push(`Ton interlocuteur s'appelle ${ctx.contactName}.`);
    if (ctx.summary) {
      parts.push(`Rappel des échanges plus anciens avec cette personne :\n${ctx.summary}`);
    }

    parts.push(
      "Tu écris dans une messagerie : pas de titres, pas de listes à puces longues, pas de mise en forme markdown. Des phrases courtes, comme un message qu'on lit sur un téléphone.",
    );

    if (this.canSendImage(incomingText)) {
      parts.push(
        "Ton interlocuteur demande une image. Commence ta réponse par « IMAGE: » " +
          "suivi d'un prompt de génération d'image détaillé (une ou deux phrases, " +
          "en anglais de préférence pour un meilleur rendu), puis saute une ligne " +
          "et ajoute une courte légende ou un mot en texte.",
      );
    }

    return parts.join("\n\n");
  }

  private messagesFor(ctx: ContactContext, incoming: string): ChatMessage[] {
    const msgs: ChatMessage[] = [{ role: "system", content: this.buildSystemPrompt(ctx, incoming) }];
    for (const turn of ctx.turns) {
      msgs.push({ role: turn.role, content: turn.content });
    }
    msgs.push({ role: "user", content: incoming });
    return msgs;
  }

  /** Faut-il répondre en vocal ? */
  private wantsVoice(incoming: IncomingMessage, reply: string): boolean {
    const mode = this.cfg.str("voice.mode");
    if (mode === "never") return false;
    if (!this.tts.available || !this.transport.capabilities.voice) return false;
    if (!this.tts.fits(reply)) return false;
    if (mode === "always") return true;
    // À la demande : soit la personne l'écrit, soit elle a elle-même envoyé un
    // vocal — dans ce cas lui répondre en texte est une petite impolitesse.
    return asksForVoice(incoming.text) || incoming.isVoice === true;
  }

  /** Traite un message entrant de bout en bout. */
  async handle(incoming: IncomingMessage): Promise<void> {
    await this.store.withContact(incoming.contactId, incoming.contactName, async (ctx) => {
      const entry: LogEntry = {
        at: Date.now(),
        contactId: ctx.contactId,
        contactName: ctx.contactName,
        incoming: incoming.text,
        verdict: "reply",
        voice: false,
      };

      try {
        const verdict = this.policy.evaluate(ctx, incoming.text);
        entry.verdict = verdict.action;

        if (verdict.action === "silent") {
          entry.reason = verdict.reason;
          // Le message est tout de même conservé : quand vous reprenez la main,
          // vous voulez voir ce qui a été dit pendant que l'assistant se taisait.
          this.store.addTurn(ctx, "user", incoming.text);
          return;
        }

        if (verdict.action === "defer") {
          entry.reason = verdict.reason;
          // Mis de côté sans entrer dans l'historique : il y entrera au moment
          // où il sera réellement traité, sinon il compterait deux fois.
          // Plusieurs messages reçus dans la nuit sont concaténés.
          ctx.pendingText = ctx.pendingText
            ? `${ctx.pendingText}\n${incoming.text}`
            : incoming.text;
          ctx.pendingSince ??= Date.now();
          return;
        }

        if (verdict.action === "escalate") {
          entry.reason = verdict.reason;
          ctx.escalated = true;
          ctx.escalatedReason = verdict.reason;
          this.store.addTurn(ctx, "user", incoming.text);
          if (verdict.message.trim()) {
            await this.transport.sendText(ctx.contactId, verdict.message);
            this.store.addTurn(ctx, "assistant", verdict.message);
            entry.outgoing = verdict.message;
          }
          await this.notifier.notify("escalation", [
            `Contact : ${ctx.contactName ?? ctx.contactId}`,
            `Raison : ${verdict.reason}`,
            "",
            `Dernier message : ${incoming.text.slice(0, 500)}`,
          ]);
          return;
        }

        await this.transport.setTyping?.(ctx.contactId, true).catch(() => undefined);

        const raw = await this.llm.chat(this.messagesFor(ctx, incoming.text));
        const reply = this.policy.clamp(raw);

        this.store.addTurn(ctx, "user", incoming.text);
        this.store.addTurn(ctx, "assistant", reply);
        delete ctx.pendingText;
        delete ctx.pendingSince;
        entry.outgoing = reply;

        // Une demande d'image se solde par l'envoi de l'image : le modèle a
        // commencé sa réponse par « IMAGE: » et le prompt de génération. Le
        // texte qui suit le marqueur part en légende de la photo.
        if (this.canSendImage(incoming.text)) {
          const imageRequest = extractImageRequest(reply);
          if (imageRequest) {
            try {
              const clip = await this.imageGen.generate(imageRequest.prompt);
              await this.transport.sendImage(
                ctx.contactId,
                clip.image,
                clip.mimeType,
                imageRequest.textAfter,
              );
              entry.image = true;
              return;
            } catch (e) {
              // Une image ratée ne doit pas faire perdre la réponse : on
              // renvoie le texte qui l'accompagnait, ou la réponse complète.
              console.error(`[snap-astreinte] image indisponible, repli texte : ${(e as Error).message}`);
              entry.reason = `image indisponible : ${(e as Error).message}`;
              if (!(e instanceof ImageError)) throw e;
              if (imageRequest.textAfter) {
                await this.transport.sendText(ctx.contactId, imageRequest.textAfter);
                return;
              }
            }
          }
        }

        if (this.wantsVoice(incoming, reply)) {
          try {
            const clip = await this.tts.synthesize(reply);
            await this.transport.sendVoice(ctx.contactId, clip.audio, clip.mimeType);
            entry.voice = true;
            return;
          } catch (e) {
            // Un vocal raté ne doit pas faire perdre la réponse : on l'envoie
            // en texte et on note pourquoi la voix n'a pas marché.
            console.error(`[snap-astreinte] vocal indisponible, repli texte : ${(e as Error).message}`);
            entry.reason = `vocal indisponible : ${(e as Error).message}`;
            if (!(e instanceof TtsError)) throw e;
          }
        }

        await this.transport.sendText(ctx.contactId, reply);
      } catch (e) {
        const message = (e as Error).message;
        entry.error = message;
        console.error(`[snap-astreinte] échec sur ${ctx.contactName ?? ctx.contactId} : ${message}`);
        await this.notifier.notify("error", [
          `Contact : ${ctx.contactName ?? ctx.contactId}`,
          `Erreur : ${message}`,
          "",
          `Message reçu : ${incoming.text.slice(0, 300)}`,
        ]);
        // Le modèle injoignable est le cas fréquent, et laisser la personne
        // sans aucun signe est pire que d'admettre le problème.
        if (e instanceof LlmError) {
          await this.transport
            .sendText(ctx.contactId, "Je n'arrive pas à répondre pour le moment, je reviens vers toi.")
            .catch(() => undefined);
        }
      } finally {
        await this.transport.setTyping?.(ctx.contactId, false).catch(() => undefined);
        this.log.push(entry);
        if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
      }
    });
  }

  /**
   * Traite les contacts laissés en attente hors plage horaire. Appelé
   * périodiquement par le démon : sans cela, un message reçu à 2 h du matin
   * attendrait que la personne réécrive.
   */
  async flushPending(): Promise<number> {
    if (!this.policy.enabled) return 0;
    let handled = 0;
    for (const stored of this.store.list()) {
      if (!stored.pendingText || stored.escalated) continue;
      // Ré-évalué maintenant : la plage horaire a pu rouvrir, mais un mot-clé
      // d'escalade dans le message doit toujours l'emporter.
      const verdict = this.policy.evaluate(stored, stored.pendingText);
      if (verdict.action === "defer") continue;

      const text = stored.pendingText;
      const since = stored.pendingSince ?? Date.now();
      await this.store.withContact(stored.contactId, stored.contactName, (ctx) => {
        delete ctx.pendingText;
        delete ctx.pendingSince;
      });
      await this.handle({
        contactId: stored.contactId,
        contactName: stored.contactName,
        text,
        receivedAt: since,
      });
      handled += 1;
    }
    return handled;
  }

  /** Rend la main à l'assistant sur un contact escaladé. */
  resume(contactId: string): boolean {
    const ctx = this.store.read(contactId);
    if (!ctx.escalated) return false;
    this.store.reset(ctx);
    return true;
  }
}
