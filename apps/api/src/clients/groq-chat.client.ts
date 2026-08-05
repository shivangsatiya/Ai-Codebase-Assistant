import Groq from 'groq-sdk';
import { performance } from 'perf_hooks';
import type { IChatCompletionProvider, StreamCompletionParams } from './chat-completion-provider';
import { logger } from '../utils/logger';

/**
 * Why Groq instead of Claude for this milestone?
 *
 * The Anthropic API requires a funded account (a $0 credit balance
 * returns a 400, confirmed live during development) - Groq's free tier
 * needs no payment method at all, matching the same "no external
 * account should be a blocker" reasoning behind the switch to local
 * embeddings on Day 3-4. The trade-off, worth being explicit about: an
 * open model (Llama 3.3 70B) via Groq can be less reliable at strictly
 * following the "always cite in this exact format" system prompt
 * instruction than Claude - if citation quality is noticeably worse in
 * testing, that's this trade-off surfacing, not a bug in the prompt or
 * extraction logic.
 */
export class GroqChatClient implements IChatCompletionProvider {
  private readonly client: Groq;

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly maxTokens: number,
  ) {
    this.client = new Groq({ apiKey });
  }

  /**
   * Why capture timing and token usage entirely inside this method,
   * rather than changing IChatCompletionProvider's return type to carry
   * this data out to the caller?
   *
   * The interface is deliberately just AsyncIterable<string> - the
   * simplest possible contract for "stream me tokens," used directly by
   * the SSE route to write each chunk to the response as it arrives.
   * Changing that shape (e.g. yielding {type, payload} events) would
   * mean every consumer, including the SSE route, has to be touched and
   * re-verified for a concern - observability - that's orthogonal to
   * what the interface exists to express. Logging this data as a
   * self-contained side effect keeps the interface unchanged, so nothing
   * downstream needed to change to add this.
   *
   * Why track time-to-first-token separately from total duration?
   *
   * These answer genuinely different questions for a streaming UX: time-
   * to-first-token is "how long until the user sees anything happen,"
   * total duration is "how long until the full answer is done" - a slow
   * total time with a fast first token feels responsive even if it isn't
   * fast overall, and that distinction is invisible in a single combined
   * number.
   *
   * Why is usage nullable in the logged output?
   *
   * Groq includes usage stats on the final chunk of a stream by default,
   * nested under `chunk.x_groq.usage` (confirmed against groq-sdk's real
   * type definitions after an initial wrong guess at `chunk.usage`
   * directly - a genuine type error caught by actually type-checking
   * this file, not assumed correct from a plausible-looking field name).
   * Unlike OpenAI, no explicit stream_options opt-in is required. Usage
   * is still nullable here defensively - if a stream ends early (client
   * disconnect, an API-side error) without ever sending that final
   * chunk, logging null is more honest than fabricating a value.
   */
  async *streamCompletion({ systemPrompt, messages }: StreamCompletionParams): AsyncIterable<string> {
    const startedAt = performance.now();
    let firstTokenAt: number | null = null;
    let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null = null;

    const stream = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [{ role: 'system', content: systemPrompt }, ...messages.map((m) => ({ role: m.role, content: m.content }))],
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        if (firstTokenAt === null) {
          firstTokenAt = performance.now();
        }
        yield content;
      }

      if (chunk.x_groq?.usage) {
        usage = {
          promptTokens: chunk.x_groq.usage.prompt_tokens,
          completionTokens: chunk.x_groq.usage.completion_tokens,
          totalTokens: chunk.x_groq.usage.total_tokens,
        };
      }
    }

    const durationMs = Math.round(performance.now() - startedAt);
    const timeToFirstTokenMs = firstTokenAt !== null ? Math.round(firstTokenAt - startedAt) : null;

    logger.info({ model: this.model, durationMs, timeToFirstTokenMs, usage }, 'LLM response complete');
  }
}
