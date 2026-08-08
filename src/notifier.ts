/**
 * Alertes à l'exploitant.
 *
 * Distinct du canal des conversations : l'assistant peut tourner sur un canal
 * et prévenir son exploitant sur un autre. C'est volontaire — quand le canal
 * principal est justement ce qui ne va pas, une alerte qui passe par lui
 * n'arrive jamais.
 *
 * Les alertes partent du compte Telegram personnel de l'exploitant (MTProto,
 * comme le canal) : aucun jeton de bot, aucun intermédiaire. La cible
 * `notify.telegram_chat_id` peut être « me » (Messages enregistrés, le
 * défaut), un identifiant numérique ou un @pseudo.
 *
 * Silencieux et sans conséquence quand il n'est pas configuré : une alerte qui
 * échoue ne doit jamais interrompre le traitement d'une demande.
 */

import { TelegramClient, sessions } from "telegram";
import type { Config } from "./config.js";
import {
  loadSessionString,
  resolveTelegramSession,
  type ResolvedTelegramSession,
} from "./telegram/session.js";

const { StringSession } = sessions;

export type NotifyKind = "escalation" | "error";

export class Notifier {
  constructor(private cfg: Config) {}

  private get enabled(): boolean {
    return (
      this.cfg.bool("notify.enabled") &&
      !!this.cfg.str("notify.telegram_chat_id").trim()
    );
  }

  private wants(kind: NotifyKind): boolean {
    return kind === "escalation"
      ? this.cfg.bool("notify.on_escalation")
      : this.cfg.bool("notify.on_error");
  }

  async notify(kind: NotifyKind, lines: string[]): Promise<void> {
    if (!this.enabled || !this.wants(kind)) return;
    const prefix = kind === "escalation" ? "Escalade" : "Erreur";
    const text = [`${prefix} — Astreinte`, "", ...lines].join("\n");

    try {
      const session = this.session();
      const client = new TelegramClient(
        new StringSession(loadSessionString(session)),
        session.apiId,
        session.apiHash,
        { connectionRetries: 3 },
      );
      await client.connect();
      if (!(await client.checkAuthorization())) {
        throw new Error("session Telegram non autorisée, relancez « npm run telegram:login »");
      }
      const chatId = this.cfg.str("notify.telegram_chat_id").trim();
      await client.sendMessage(chatId, { message: text.slice(0, 4000) });
      await client.disconnect().catch(() => undefined);
    } catch (e) {
      console.error(`[snap-astreinte] alerte non délivrée : ${(e as Error).message}`);
    }
  }

  /** Les alertes réutilisent la session du canal : un seul compte à gérer. */
  private session(): ResolvedTelegramSession {
    return resolveTelegramSession({
      apiId: this.cfg.num("transport.telegram_api_id") || undefined,
      apiHash: this.cfg.str("transport.telegram_api_hash") || undefined,
      sessionFile: this.cfg.str("transport.telegram_session_file") || undefined,
    });
  }
}
