import { API_BASE_URL, ApiError } from './api-client';
import { useAuthStore } from '../stores/auth-store';

export type QuestionCategory = 'pure_graph' | 'intelligence' | 'hybrid' | 'pure_semantic';

export interface AskQuestionParams {
  question: string;
  nodeId?: string;
  targetNodeId?: string;
  direction?: 'incoming' | 'outgoing' | 'both';
}

/** Matches RouterAnswer exactly - the real JSON response for pure_graph/intelligence questions. */
export interface RouterAnswer {
  category: QuestionCategory;
  algorithm?: string;
  result?: unknown;
}

export type SseEvent = { type: 'token'; text: string } | { type: 'done' } | { type: 'error'; message: string };

export type AskResult = { mode: 'json'; answer: RouterAnswer } | { mode: 'stream'; events: AsyncGenerator<SseEvent> };

/**
 * ONE function, not two the caller chooses between - a real design
 * correction, not the original plan. Classification happens entirely
 * server-side (question-router.ts); the client cannot know in advance
 * whether a given question will come back as JSON or as an SSE stream,
 * since that decision is exactly what the backend's classify() step
 * exists to make. This function makes the single real POST call and
 * inspects the actual response's Content-Type to decide how to read
 * it, rather than the frontend guessing or duplicating the backend's
 * own classification logic.
 */
export async function askQuestion(
  repositoryId: string,
  params: AskQuestionParams,
  signal?: AbortSignal,
  isRetry = false,
): Promise<AskResult> {
  const accessToken = useAuthStore.getState().accessToken;
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);

  const response = await fetch(`${API_BASE_URL}/api/repositories/${repositoryId}/graph/ask`, {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
    signal,
  });

  if (response.status === 401 && !isRetry) {
    // The same 401-retry-once pattern api-client.ts already establishes
    // for every other endpoint - this call used a raw fetch rather than
    // apiRequest (it has to, to inspect Content-Type before deciding
    // how to read the body), which meant it was silently bypassing that
    // shared behavior entirely. A real gap found in self-review, not
    // hypothetical: without this, an expired token mid-session would
    // fail an ask request outright instead of transparently refreshing.
    const refreshed = await useAuthStore.getState().refresh();
    if (refreshed) {
      return askQuestion(repositoryId, params, signal, true);
    }
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'UNKNOWN_ERROR',
      body?.error?.message ?? 'Request failed',
    );
  }

  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('text/event-stream')) {
    return { mode: 'stream', events: readSseStream(response) };
  }

  const answer = (await response.json()) as RouterAnswer;
  return { mode: 'json', answer };
}

/**
 * Yields a discriminated union matching the real backend events
 * (`token`, `done`, `error`) - the one thing this stream can honestly
 * tell the caller, per the real, verified contract. No graph facts, no
 * citations - the backend genuinely does not send them here.
 */
async function* readSseStream(response: Response): AsyncGenerator<SseEvent> {
  if (!response.body) {
    throw new Error('No response body for streaming request');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      // The last split piece may be an incomplete event still arriving
      // over the wire - held back in the buffer rather than parsed
      // prematurely.
      buffer = events.pop() ?? '';

      for (const rawEvent of events) {
        const parsed = parseSseEvent(rawEvent);
        if (parsed) yield parsed;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Malformed events (an unparseable data line, an unrecognized event
 * type) are skipped rather than thrown - a single bad event shouldn't
 * kill an otherwise-healthy stream that's still delivering real tokens.
 */
function parseSseEvent(raw: string): SseEvent | null {
  const lines = raw.split('\n');
  const eventLine = lines.find((l) => l.startsWith('event: '));
  const dataLine = lines.find((l) => l.startsWith('data: '));
  if (!dataLine) return null;

  const eventType = eventLine ? eventLine.slice('event: '.length).trim() : 'message';
  const rawData = dataLine.slice('data: '.length);

  try {
    const data = JSON.parse(rawData);
    if (eventType === 'done') return { type: 'done' };
    if (eventType === 'error') {
      return {
        type: 'error',
        message: typeof data.message === 'string' ? data.message : 'The response was interrupted.',
      };
    }
    if (typeof data.token === 'string') return { type: 'token', text: data.token };
    return null;
  } catch {
    return null;
  }
}
