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

export class LlmError extends Error {}

export class Llm {
  constructor(private opts: LlmOptions) {}

  async chat(messages: ChatMessage[], maxTokens = 700): Promise<string> {
    const url = `${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 120_000);

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.opts.apiKey) headers.Authorization = `Bearer ${this.opts.apiKey}`;

      const res = await fetch(url, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: this.opts.model || "local",
          messages,
          temperature: this.opts.temperature ?? 0.4,
          max_tokens: maxTokens,
          stream: false,
        }),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new LlmError(`modèle ${res.status} : ${detail.slice(0, 300)}`);
      }

      const body = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = body.choices?.[0]?.message?.content;
      if (!content || !content.trim()) throw new LlmError("réponse vide du modèle");
      return content.trim();
    } catch (e) {
      if (e instanceof LlmError) throw e;
      if ((e as Error).name === "AbortError") {
        throw new LlmError(`le modèle n'a pas répondu dans le délai imparti (${url})`);
      }
      throw new LlmError(`${(e as Error).message} (${url})`);
    } finally {
      clearTimeout(timer);
    }
  }
}
