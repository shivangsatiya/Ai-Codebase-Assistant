export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamCompletionParams {
  systemPrompt: string;
  messages: ChatMessage[];
}

/**
 * Same dependency-injection pattern as IEmbeddingProvider: the chat
 * orchestration service depends on this interface, not any specific
 * provider's SDK directly, so tests can inject a fake that yields deterministic tokens
 * with no real API call, no API key, and no cost.
 */
export interface IChatCompletionProvider {
  streamCompletion(params: StreamCompletionParams): AsyncIterable<string>;
}
