/**
 * Client de modèle, API compatible OpenAI.
 *
 * Volontairement minimal : pas de streaming, pas d'outils. Une réponse de
 * dépannage part en un bloc, et le canal de destination ne sait de toute façon
 * pas afficher un flux — un message Telegram ou un vocal est atomique.
 */
export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}
export interface LlmOptions {
    baseUrl: string;
    model: string;
    apiKey?: string;
    temperature?: number;
    /** Millisecondes. Un modèle local qui charge peut être lent au premier appel. */
    timeoutMs?: number;
}
export declare class LlmError extends Error {
}
export declare class Llm {
    private opts;
    constructor(opts: LlmOptions);
    chat(messages: ChatMessage[], maxTokens?: number): Promise<string>;
}
