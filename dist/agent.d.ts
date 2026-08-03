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
import { Policy } from "./policy.js";
import { ContactStore } from "./store.js";
import { Tts } from "./tts.js";
import type { Transport } from "./transports/types.js";
import type { ContactContext, IncomingMessage, LogEntry } from "./types.js";
export declare class Agent {
    private cfg;
    private transport;
    readonly store: ContactStore;
    readonly policy: Policy;
    readonly tts: Tts;
    private llm;
    private notifier;
    private log;
    constructor(cfg: Config, transport: Transport);
    recentLog(limit?: number): LogEntry[];
    /** Instructions système, reconstruites à chaque message : la config peut bouger. */
    buildSystemPrompt(ctx: ContactContext): string;
    private messagesFor;
    /** Faut-il répondre en vocal ? */
    private wantsVoice;
    /** Traite un message entrant de bout en bout. */
    handle(incoming: IncomingMessage): Promise<void>;
    /**
     * Traite les contacts laissés en attente hors plage horaire. Appelé
     * périodiquement par le démon : sans cela, un message reçu à 2 h du matin
     * attendrait que la personne réécrive.
     */
    flushPending(): Promise<number>;
    /** Rend la main à l'assistant sur un contact escaladé. */
    resume(contactId: string): boolean;
}
