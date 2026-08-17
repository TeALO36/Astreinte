/** Types partagés par toute l'extension. */

/** Un message reçu d'un interlocuteur, quel que soit le canal. */
export interface IncomingMessage {
  /** Identifiant stable de l'interlocuteur pour ce canal. Clé du contexte. */
  contactId: string;
  /** Nom affichable, quand le canal en fournit un. */
  contactName?: string;
  /** Texte du message. Vide si le message n'était que de l'audio. */
  text: string;
  /** L'interlocuteur a envoyé un vocal (utile pour lui répondre de même). */
  isVoice?: boolean;
  /** Millisecondes epoch. */
  receivedAt: number;
}

/** Une réponse prête à partir. */
export interface OutgoingMessage {
  text: string;
  /** Quand vrai, le texte est synthétisé et envoyé en note vocale. */
  asVoice: boolean;
}

/** Un tour de conversation conservé dans le contexte d'un contact. */
export interface Turn {
  role: "user" | "assistant";
  content: string;
  at: number;
}

/** Le contexte complet d'un interlocuteur. Jamais partagé entre contacts. */
export interface ContactContext {
  contactId: string;
  contactName?: string;
  /** Tours récents, du plus ancien au plus récent. */
  turns: Turn[];
  /** Résumé des tours plus anciens, retirés de `turns`. */
  summary?: string;
  /** Nombre de tours depuis le début de la demande en cours. */
  turnCount: number;
  /** L'affaire a été passée à l'humain : l'assistant se tait jusqu'à reprise. */
  escalated: boolean;
  escalatedReason?: string;
  /** Message reçu hors plage horaire, en attente de la réouverture. */
  pendingText?: string;
  pendingSince?: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

/** Verdict du moteur de politique avant de laisser le modèle répondre. */
export type PolicyVerdict =
  | { action: "reply" }
  | { action: "escalate"; reason: string; message: string }
  | { action: "defer"; reason: string }
  | { action: "silent"; reason: string };

/** Trace d'un échange, pour la supervision depuis le host MCP. */
export interface LogEntry {
  at: number;
  contactId: string;
  contactName?: string;
  incoming: string;
  outgoing?: string;
  verdict: PolicyVerdict["action"];
  reason?: string;
  voice: boolean;
  /** Une image a été envoyée en réponse. */
  image?: boolean;
  error?: string;
}
