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
export declare class Notifier {
    private cfg;
    constructor(cfg: Config);
    private get enabled();
    private wants;
    notify(kind: NotifyKind, lines: string[]): Promise<void>;
}
