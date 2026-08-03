import Groq from 'groq-sdk';
import type { IChatCompletionProvider, StreamCompletionParams } from './chat-completion-provider';

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

  async *streamCompletion({ systemPrompt, messages }: StreamCompletionParams): AsyncIterable<string> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [{ role: 'system', content: systemPrompt }, ...messages.map((m) => ({ role: m.role, content: m.content }))],
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  }
}
