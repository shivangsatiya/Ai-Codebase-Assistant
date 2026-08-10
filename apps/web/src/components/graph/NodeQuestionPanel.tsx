import { useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { isAiGenerated, type ArchitectureAnswer } from '../../lib/architecture-answer';
import { suggestedQuestionsFor } from '../../lib/suggested-questions';

interface NodeQuestionPanelProps {
  nodeType: string;
  history: ArchitectureAnswer[];
  isAsking: boolean;
  onAsk: (question: string) => void;
  onCancel: () => void;
  onClearHistory: () => void;
}

export function NodeQuestionPanel({ nodeType, history, isAsking, onAsk, onCancel, onClearHistory }: NodeQuestionPanelProps) {
  const [draft, setDraft] = useState('');

  function submit() {
    const trimmed = draft.trim();
    if (!trimmed || isAsking) return;
    onAsk(trimmed);
    setDraft('');
  }

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-fg-muted">Ask about this component</p>
        {history.length > 0 && (
          <button
            onClick={onClearHistory}
            disabled={isAsking}
            aria-label="Clear history for this component"
            className="text-[11px] text-fg-subtle hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            Clear history
          </button>
        )}
      </div>

      {history.length === 0 && (
        <div className="flex flex-wrap gap-1.5">
          {suggestedQuestionsFor(nodeType)
            .slice(0, 3)
            .map((q) => (
              <button
                key={q}
                onClick={() => setDraft(q)}
                className="rounded-md border border-border bg-surface-elevated px-2 py-1 text-left text-[11px] text-fg-muted hover:text-fg"
              >
                {q}
              </button>
            ))}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {history.map((answer) => (
          <AnswerEntry key={answer.id} answer={answer} />
        ))}
      </div>

      <div className="flex gap-2">
        <label htmlFor="ask-question-input" className="sr-only">
          Ask a question about this component
        </label>
        <Input
          id="ask-question-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Why does this depend on Redis?"
          disabled={isAsking}
        />
        {isAsking ? (
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        ) : (
          <Button size="sm" onClick={submit} disabled={draft.trim().length === 0}>
            Ask
          </Button>
        )}
      </div>
    </div>
  );
}

function AnswerEntry({ answer }: { answer: ArchitectureAnswer }) {
  const aiGenerated = isAiGenerated(answer.category);

  return (
    <div
      className="flex flex-col gap-1 rounded-md border border-border bg-surface-elevated p-2 text-xs"
      role="group"
      aria-label={`Question: ${answer.question}`}
    >
      <p className="font-medium text-fg">Q: {answer.question}</p>

      {answer.status === 'loading' && <p className="text-fg-subtle">Generating answer…</p>}

      {answer.status === 'streaming' && (
        <div aria-live="polite">
          {answer.graphFacts && (
            <div className="rounded border border-border bg-bg px-2 py-1 text-[10px] text-fg-subtle">
              <span className="font-medium text-fg-muted">Graph Facts</span> — computed from the repository graph:{' '}
              {answer.graphFacts.incomingCount} incoming, {answer.graphFacts.outgoingCount} outgoing
            </div>
          )}
          <p className="whitespace-pre-wrap text-fg">{answer.streamedText || 'Thinking…'}</p>
        </div>
      )}

      {answer.status === 'complete' && (
        <>
          {answer.graphFacts && (
            <div className="rounded border border-border bg-bg px-2 py-1 text-[10px] text-fg-subtle">
              <span className="font-medium text-fg-muted">Graph Facts</span> — computed from the repository graph:{' '}
              {answer.graphFacts.incomingCount} incoming, {answer.graphFacts.outgoingCount} outgoing
            </div>
          )}
          <p className="mb-1 text-[10px] uppercase tracking-wide text-fg-subtle">
            {aiGenerated ? 'AI-generated explanation' : 'Computed directly — no AI involved'}
          </p>
          <p className="whitespace-pre-wrap text-fg">{answer.structuredSummary ?? answer.streamedText}</p>
        </>
      )}

      {answer.status === 'error' && (
        <div role="alert">
          {answer.wasInterrupted && answer.streamedText && (
            <p className="mb-1 whitespace-pre-wrap text-fg">{answer.streamedText}</p>
          )}
          <p className="text-danger">
            {answer.wasInterrupted ? 'The response was interrupted. ' : ''}
            {answer.errorMessage ?? 'Something went wrong.'}
          </p>
        </div>
      )}
    </div>
  );
}
