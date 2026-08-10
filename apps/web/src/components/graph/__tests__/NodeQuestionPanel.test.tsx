import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NodeQuestionPanel } from '../NodeQuestionPanel';
import type { ArchitectureAnswer } from '../../../lib/architecture-answer';

describe('NodeQuestionPanel - composer', () => {
  it('shows suggested questions when there is no history yet', () => {
    render(<NodeQuestionPanel nodeType="service" history={[]} isAsking={false} onAsk={vi.fn()} onCancel={vi.fn()} onClearHistory={vi.fn()} />);

    expect(screen.getByText(/why does this service depend on redis/i)).toBeInTheDocument();
  });

  it('clicking a suggestion fills the input, ready to send - does not submit immediately on its own', async () => {
    const onAsk = vi.fn();
    const user = userEvent.setup();
    render(<NodeQuestionPanel nodeType="service" history={[]} isAsking={false} onAsk={onAsk} onCancel={vi.fn()} onClearHistory={vi.fn()} />);

    await user.click(screen.getByText(/why does this service depend on redis/i));

    expect(onAsk).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(/why does this depend on redis/i)).toHaveValue(
      'Why does this service depend on Redis?',
    );
  });

  it('disables the Ask button for an empty question, without calling onAsk', async () => {
    const onAsk = vi.fn();
    const user = userEvent.setup();
    render(<NodeQuestionPanel nodeType="service" history={[]} isAsking={false} onAsk={onAsk} onCancel={vi.fn()} onClearHistory={vi.fn()} />);

    const askButton = screen.getByRole('button', { name: /^ask$/i });
    expect(askButton).toBeDisabled();
    await user.click(askButton);
    expect(onAsk).not.toHaveBeenCalled();
  });

  it('submits a real question via the Ask button and clears the composer', async () => {
    const onAsk = vi.fn();
    const user = userEvent.setup();
    render(<NodeQuestionPanel nodeType="service" history={[]} isAsking={false} onAsk={onAsk} onCancel={vi.fn()} onClearHistory={vi.fn()} />);

    const input = screen.getByPlaceholderText(/why does this depend on redis/i);
    await user.type(input, 'What does this call?');
    await user.click(screen.getByRole('button', { name: /^ask$/i }));

    expect(onAsk).toHaveBeenCalledWith('What does this call?');
    expect(input).toHaveValue('');
  });

  it('submits on Enter, per the explicit keyboard-accessibility requirement', async () => {
    const onAsk = vi.fn();
    const user = userEvent.setup();
    render(<NodeQuestionPanel nodeType="service" history={[]} isAsking={false} onAsk={onAsk} onCancel={vi.fn()} onClearHistory={vi.fn()} />);

    const input = screen.getByPlaceholderText(/why does this depend on redis/i);
    await user.type(input, 'Who calls this?{Enter}');

    expect(onAsk).toHaveBeenCalledWith('Who calls this?');
  });

  it('shows Cancel instead of Ask while a question is in flight, and disables the input', () => {
    render(<NodeQuestionPanel nodeType="service" history={[]} isAsking={true} onAsk={vi.fn()} onCancel={vi.fn()} onClearHistory={vi.fn()} />);

    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^ask$/i })).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/why does this depend on redis/i)).toBeDisabled();
  });

  it('calls onCancel when Cancel is clicked mid-stream', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<NodeQuestionPanel nodeType="service" history={[]} isAsking={true} onAsk={vi.fn()} onCancel={onCancel} onClearHistory={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not show a "Clear history" option when there is no history yet', () => {
    render(
      <NodeQuestionPanel nodeType="service" history={[]} isAsking={false} onAsk={vi.fn()} onCancel={vi.fn()} onClearHistory={vi.fn()} />,
    );

    expect(screen.queryByRole('button', { name: /clear history/i })).not.toBeInTheDocument();
  });

  it('shows and calls "Clear history" once there is real history to clear', async () => {
    const onClearHistory = vi.fn();
    const user = userEvent.setup();
    const history: ArchitectureAnswer[] = [
      { id: '1', question: 'what does this depend on?', nodeId: 'n1', status: 'complete', structuredSummary: 'axios' },
    ];
    render(
      <NodeQuestionPanel
        nodeType="service"
        history={history}
        isAsking={false}
        onAsk={vi.fn()}
        onCancel={vi.fn()}
        onClearHistory={onClearHistory}
      />,
    );

    const clearButton = screen.getByRole('button', { name: /clear history/i });
    await user.click(clearButton);
    expect(onClearHistory).toHaveBeenCalledTimes(1);
  });

  it('disables "Clear history" while a question is in flight', () => {
    const history: ArchitectureAnswer[] = [
      { id: '1', question: 'what does this depend on?', nodeId: 'n1', status: 'complete', structuredSummary: 'axios' },
    ];
    render(
      <NodeQuestionPanel nodeType="service" history={history} isAsking={true} onAsk={vi.fn()} onCancel={vi.fn()} onClearHistory={vi.fn()} />,
    );

    expect(screen.getByRole('button', { name: /clear history/i })).toBeDisabled();
  });
});

describe('NodeQuestionPanel - answer rendering, epistemic honesty', () => {
  it('labels a Pure Graph/Intelligence answer as computed, never as AI-generated', () => {
    const history: ArchitectureAnswer[] = [
      {
        id: '1',
        question: 'what does this depend on?',
        nodeId: 'n1',
        status: 'complete',
        category: 'pure_graph',
        structuredSummary: 'axios, react',
      },
    ];
    render(
      <NodeQuestionPanel nodeType="service" history={history} isAsking={false} onAsk={vi.fn()} onCancel={vi.fn()} onClearHistory={vi.fn()} />,
    );

    expect(screen.getByText(/computed directly.*no ai involved/i)).toBeInTheDocument();
    expect(screen.queryByText(/ai-generated/i)).not.toBeInTheDocument();
  });

  it('labels a Hybrid/Semantic answer as AI-generated, and labels Graph Facts distinctly from it - never as "evidence used by AI"', () => {
    const history: ArchitectureAnswer[] = [
      {
        id: '1',
        question: 'why does this depend on Redis?',
        nodeId: 'n1',
        status: 'complete',
        category: 'hybrid',
        streamedText: 'Because it caches session data.',
        graphFacts: { incomingCount: 3, outgoingCount: 5 },
      },
    ];
    render(
      <NodeQuestionPanel nodeType="service" history={history} isAsking={false} onAsk={vi.fn()} onCancel={vi.fn()} onClearHistory={vi.fn()} />,
    );

    expect(screen.getByText(/ai-generated explanation/i)).toBeInTheDocument();
    expect(screen.getByText(/graph facts/i)).toBeInTheDocument();
    expect(screen.getByText(/computed from the repository graph/i)).toBeInTheDocument();
    expect(screen.queryByText(/evidence used by ai/i)).not.toBeInTheDocument();
  });

  it('shows partial streamed text alongside an interruption error, never silently discarding it', () => {
    const history: ArchitectureAnswer[] = [
      {
        id: '1',
        question: 'explain this',
        nodeId: 'n1',
        status: 'error',
        streamedText: 'Partial answer before it broke.',
        wasInterrupted: true,
        errorMessage: 'The response was interrupted. Please try again.',
      },
    ];
    render(
      <NodeQuestionPanel nodeType="service" history={history} isAsking={false} onAsk={vi.fn()} onCancel={vi.fn()} onClearHistory={vi.fn()} />,
    );

    expect(screen.getByText(/partial answer before it broke/i)).toBeInTheDocument();
    expect(screen.getByText(/interrupted/i)).toBeInTheDocument();
  });
});
