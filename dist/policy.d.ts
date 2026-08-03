/**
 * Garde-fous et escalade.
 *
 * Décidés **avant** d'appeler le modèle, jamais après : demander au modèle de
 * juger s'il a le droit de répondre revient à lui confier la garde de sa propre
 * limite. Ici, si la politique dit « escalade », aucun appel n'est fait et le
 * message d'escalade configuré part tel quel.
 *
 * Tout ce fichier est neutralisé quand `limits.enabled` est décoché — c'est le
 * mode 100 % autonome sans intervention, assumé par celui qui l'active.
 */
import type { Config } from "./config.js";
import type { ContactContext, PolicyVerdict } from "./types.js";
/** `"08:00-22:00"` → est-on dans la plage ? Vide = toujours. */
export declare function withinActiveHours(spec: string, now?: Date): boolean;
export declare class Policy {
    private cfg;
    constructor(cfg: Config);
    get enabled(): boolean;
    /** Décide quoi faire d'un message entrant. */
    evaluate(ctx: ContactContext, incoming: string): PolicyVerdict;
    /**
     * Rogne une réponse trop longue sans la couper au milieu d'un mot. La limite
     * existe autant pour le confort de lecture que pour éviter qu'un modèle
     * bavard ne transforme un dépannage en dissertation.
     */
    clamp(reply: string): string;
    /** Le bloc d'instructions que la politique impose au modèle. */
    promptFragment(): string;
}
