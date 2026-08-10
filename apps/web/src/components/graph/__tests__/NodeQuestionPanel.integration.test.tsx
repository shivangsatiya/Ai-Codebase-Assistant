import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NodeQuestionPanel } from '../NodeQuestionPanel';
import { useAskQuestion } from '../../../hooks/use-ask-question';
import { useAuthStore } from '../../../stores/auth-store';
import { useQuestionHistoryStore } from '../../../stores/question-history-store';

function Harness({ nodeId }: { nodeId: string }) {
  const { history, ask, isAsking, cancel, clearHistory } = useAskQuestion('repo-1', nodeId, [], new Map());
  return (
    <NodeQuestionPanel
      nodeType="service"
      history={history}
      isAsking={isAsking}
      onAsk={ask}
      onCancel={cancel}
      onClearHistory={clearHistory}
    />
  );
}

describe('NodeQuestionPanel + useAskQuestion - real integration', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'token', isAuthenticated: true });
    useQuestionHistoryStore.setState({ historyByNodeId: {} });
  });

  it('REGRESSION: Cancel actually renders while a real request is genuinely in flight, not just when isAsking is passed as a hardcoded prop', async () => {
    let releaseFirstChunk: (() => void) | undefined;
    const firstChunkGate = new Promise<void>((resolve) => {
      releaseFirstChunk = resolve;
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: {
        getReader: () => {
          let delivered = false;
          return {
            read: async () => {
              if (!delivered) {
                await firstChunkGate;
                delivered = true;
                return { done: false, value: new TextEncoder().encode('data: {"token":"partial"}\n\n') };
              }
              return new Promise(() => undefined);
            },
            releaseLock: () => {},
          };
        },
      },
    });

    const user = userEvent.setup();
    render(<Harness nodeId="node-1" />);

    const input = screen.getByPlaceholderText(/why does this depend on redis/i);
    await user.type(input, 'why does this depend on Redis?');
    await user.click(screen.getByRole('button', { name: /^ask$/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^ask$/i })).not.toBeInTheDocument();

    releaseFirstChunk?.();
    await waitFor(() => expect(screen.getByText(/partial/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });
});
