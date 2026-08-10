import { describe, it, expect, vi, beforeEach } from 'vitest';
import { askQuestion } from '../ask-api';
import { useAuthStore } from '../../stores/auth-store';

function mockJsonResponse(body: unknown, contentType = 'application/json') {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': contentType }),
    json: async () => body,
  };
}

function mockStreamResponse(chunks: string[]) {
  let index = 0;
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: {
      getReader: () => ({
        read: async () => {
          if (index >= chunks.length) return { done: true, value: undefined };
          const value = encoder.encode(chunks[index]);
          index++;
          return { done: false, value };
        },
        releaseLock: () => {},
      }),
    },
  };
}

describe('askQuestion - response mode branching', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'token', isAuthenticated: true });
  });

  it('returns JSON mode for a plain application/json response - Pure Graph/Intelligence questions', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockJsonResponse({
        category: 'pure_graph',
        algorithm: 'dependency-analysis',
        result: { mode: 'direct', nodeIds: ['a', 'b'] },
      }),
    );

    const result = await askQuestion('repo-1', { question: 'what does this depend on?', nodeId: 'x' });

    expect(result.mode).toBe('json');
    if (result.mode === 'json') {
      expect(result.answer.category).toBe('pure_graph');
      expect(result.answer.result).toEqual({ mode: 'direct', nodeIds: ['a', 'b'] });
    }
  });

  it('returns stream mode for a text/event-stream response - Hybrid/Semantic questions, WITHOUT the caller needing to know this in advance from the question text', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(mockStreamResponse(['data: {"token":"Hi"}\n\n', 'event: done\ndata: {}\n\n']));

    const result = await askQuestion('repo-1', { question: 'why does this depend on Redis?', nodeId: 'x' });

    expect(result.mode).toBe('stream');
  });
});

describe('askQuestion - SSE stream parsing', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'token', isAuthenticated: true });
  });

  it('accumulates token events correctly across multiple chunks', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        mockStreamResponse(['data: {"token":"Hello"}\n\n', 'data: {"token":" world"}\n\n', 'event: done\ndata: {}\n\n']),
      );

    const result = await askQuestion('repo-1', { question: 'why?', nodeId: 'x' });
    expect(result.mode).toBe('stream');
    if (result.mode !== 'stream') return;

    const events = [];
    for await (const event of result.events) events.push(event);

    expect(events).toEqual([
      { type: 'token', text: 'Hello' },
      { type: 'token', text: ' world' },
      { type: 'done' },
    ]);
  });

  it('handles a token split across two separate reads (a real network chunking scenario), without losing or duplicating it', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(mockStreamResponse(['data: {"tok', 'en":"partial"}\n\n', 'event: done\ndata: {}\n\n']));

    const result = await askQuestion('repo-1', { question: 'why?', nodeId: 'x' });
    if (result.mode !== 'stream') throw new Error('expected stream mode');

    const events = [];
    for await (const event of result.events) events.push(event);

    expect(events).toEqual([{ type: 'token', text: 'partial' }, { type: 'done' }]);
  });

  it('skips a malformed event without crashing the stream or losing subsequent valid events', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        mockStreamResponse(['data: not-valid-json\n\n', 'data: {"token":"still works"}\n\n', 'event: done\ndata: {}\n\n']),
      );

    const result = await askQuestion('repo-1', { question: 'why?', nodeId: 'x' });
    if (result.mode !== 'stream') throw new Error('expected stream mode');

    const events = [];
    for await (const event of result.events) events.push(event);

    expect(events).toEqual([{ type: 'token', text: 'still works' }, { type: 'done' }]);
  });

  it('surfaces a real error event distinctly from a completed stream', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockStreamResponse([
        'data: {"token":"partial answer"}\n\n',
        'event: error\ndata: {"message":"The response was interrupted. Please try again."}\n\n',
      ]),
    );

    const result = await askQuestion('repo-1', { question: 'why?', nodeId: 'x' });
    if (result.mode !== 'stream') throw new Error('expected stream mode');

    const events = [];
    for await (const event of result.events) events.push(event);

    expect(events).toEqual([
      { type: 'token', text: 'partial answer' },
      { type: 'error', message: 'The response was interrupted. Please try again.' },
    ]);
  });
});
