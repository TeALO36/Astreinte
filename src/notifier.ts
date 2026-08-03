/**
 * Alertes à l'exploitant.
 *
 * Distinct du canal des conversations : l'assistant peut tourner sur un canal
 * et prévenir son exploitant sur un autre. C'est volontaire — quand le canal
 * principal est justement ce qui ne va pas, une alerte qui passe par lui
 * n'arrive jamais.
 *
 * Silencieux et sans conséquence quand il n'est pas configuré : une alerte qui
 * échoue ne doit jamais interrompre le traitement d'une demande.
 */

import type { Config } from "./config.js";

export type NotifyKind = "escalation" | "error";

export class Notifier {
  constructor(private cfg: Config) {}

  private get enabled(): boolean {
    return (
      this.cfg.bool("notify.enabled") &&
      !!this.cfg.str("notify.telegram_token").trim() &&
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
    const prefix = kind === "escalation" ? "🔔 Escalade" : "⚠️ Erreur";
    const text = [`${prefix} — Astreinte`, "", ...lines].join("\n");

    try {
      const token = this.cfg.str("notify.telegram_token").trim();
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.cfg.str("notify.telegram_chat_id").trim(),
          text: text.slice(0, 4000),
        }),
      });
    } catch (e) {
      console.error(`[snap-astreinte] alerte non délivrée : ${(e as Error).message}`);
    }
  }
}
