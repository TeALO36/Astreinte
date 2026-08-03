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
/** Normalise pour comparer sans se faire avoir par accents et casse. */
function fold(s) {
    return s
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
}
/** `"08:00-22:00"` → est-on dans la plage ? Vide = toujours. */
export function withinActiveHours(spec, now = new Date()) {
    const trimmed = spec.trim();
    if (!trimmed)
        return true;
    const m = trimmed.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!m)
        return true; // Une plage mal écrite ne doit pas rendre l'assistant muet.
    const [, h1, m1, h2, m2] = m;
    const start = Number(h1) * 60 + Number(m1);
    const end = Number(h2) * 60 + Number(m2);
    const cur = now.getHours() * 60 + now.getMinutes();
    // Une plage qui passe minuit (22:00-06:00) est traitée comme telle.
    return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}
export class Policy {
    cfg;
    constructor(cfg) {
        this.cfg = cfg;
    }
    get enabled() {
        return this.cfg.bool("limits.enabled");
    }
    /** Décide quoi faire d'un message entrant. */
    evaluate(ctx, incoming) {
        if (!this.enabled)
            return { action: "reply" };
        // Une affaire déjà passée à l'humain le reste : ré-embrayer tout seul
        // derrière une escalade est précisément ce qu'on veut éviter.
        if (ctx.escalated) {
            return { action: "silent", reason: `déjà escaladé : ${ctx.escalatedReason ?? "raison inconnue"}` };
        }
        if (!withinActiveHours(this.cfg.str("limits.active_hours"))) {
            return { action: "defer", reason: "hors plage horaire" };
        }
        const folded = fold(incoming);
        const hit = this.cfg
            .list("limits.escalation_keywords")
            .map((k) => k.trim())
            .filter(Boolean)
            .find((k) => folded.includes(fold(k)));
        if (hit) {
            return {
                action: "escalate",
                reason: `mot-clé « ${hit} »`,
                message: this.cfg.str("limits.escalation_message"),
            };
        }
        const maxTurns = this.cfg.num("limits.max_turns_before_escalation");
        if (maxTurns > 0 && ctx.turnCount >= maxTurns) {
            return {
                action: "escalate",
                reason: `${ctx.turnCount} tours sans résolution`,
                message: this.cfg.str("limits.escalation_message"),
            };
        }
        return { action: "reply" };
    }
    /**
     * Rogne une réponse trop longue sans la couper au milieu d'un mot. La limite
     * existe autant pour le confort de lecture que pour éviter qu'un modèle
     * bavard ne transforme un dépannage en dissertation.
     */
    clamp(reply) {
        if (!this.enabled)
            return reply;
        const max = this.cfg.num("limits.max_reply_chars");
        if (max <= 0 || reply.length <= max)
            return reply;
        const cut = reply.slice(0, max);
        const lastBreak = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "), cut.lastIndexOf(" "));
        const body = lastBreak > max * 0.6 ? cut.slice(0, lastBreak) : cut;
        return `${body.trimEnd()}…\n\n(Dis-moi si tu veux que je détaille.)`;
    }
    /** Le bloc d'instructions que la politique impose au modèle. */
    promptFragment() {
        if (!this.enabled)
            return "";
        const scope = this.cfg.str("limits.scope").trim();
        const forbidden = this.cfg.str("limits.forbidden").trim();
        const parts = [];
        if (scope)
            parts.push(`Tu traites uniquement : ${scope}`);
        if (forbidden) {
            parts.push(`Tu ne traites pas et tu passes la main pour : ${forbidden}\n` +
                `Dans ces cas, dis simplement que tu transmets, sans improviser de solution.`);
        }
        const max = this.cfg.num("limits.max_reply_chars");
        if (max > 0)
            parts.push(`Réponses courtes, ${max} caractères maximum.`);
        return parts.join("\n\n");
    }
}
//# sourceMappingURL=policy.js.map