import { useParams } from 'react-router-dom';
import { useMemo } from 'react';
import { useRepository } from '../../hooks/use-repositories';
import { useRepositoryGraph } from '../../hooks/use-graph';
import { useGraphUiStore } from '../../stores/graph-ui-store';
import { useAskQuestion } from '../../hooks/use-ask-question';
import { adaptGraph } from '../../lib/graph-adapter';
import { computeNodeRelationships } from '../../lib/graph-relationships';
import { Skeleton } from '../ui/skeleton';
import { NodeQuestionPanel } from '../graph/NodeQuestionPanel';

export function Inspector() {
  const { repositoryId } = useParams<{ repositoryId?: string }>();
  const { data: repository, isLoading, isError } = useRepository(repositoryId);
  const { data: graphResponse } = useRepositoryGraph(repositoryId);
  const selectedNodeId = useGraphUiStore((s) => s.selectedNodeId);
  const selectNode = useGraphUiStore((s) => s.selectNode);

  const adapted = useMemo(
    () => adaptGraph(graphResponse?.nodes ?? [], graphResponse?.edges ?? []),
    [graphResponse],
  );

  const labelById = useMemo(() => new Map(adapted.nodes.map((n) => [n.id, n.data.label])), [adapted.nodes]);

  const selectedNode = selectedNodeId ? adapted.nodes.find((n) => n.id === selectedNodeId) : undefined;

  // The orchestrator hook is called unconditionally (React hooks rule)
  // with a safe empty-string fallback for repositoryId - the question
  // panel itself is only ever rendered below when both a real
  // repositoryId and a real selectedNode exist, so `ask` is never
  // actually invoked with the fallback value.
  const { history, ask, isAsking, cancel, clearHistory } = useAskQuestion(
    repositoryId ?? '',
    selectedNodeId ?? '',
    adapted.edges,
    labelById,
  );

  if (selectedNode) {
    const relationships = computeNodeRelationships(selectedNode.id, adapted.edges);
    const incoming = adapted.edges.filter((e) => e.target === selectedNode.id);
    const outgoing = adapted.edges.filter((e) => e.source === selectedNode.id);
    const nodeById = new Map(adapted.nodes.map((n) => [n.id, n]));

    return (
      <aside data-testid="inspector-panel" className="flex h-full w-full flex-col gap-3 overflow-y-auto border-l border-border bg-surface p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-mono text-sm font-medium text-fg">{selectedNode.data.label}</p>
            <p className="text-xs text-fg-subtle">{selectedNode.data.nodeType}</p>
          </div>
          <button
            onClick={() => selectNode(null)}
            aria-label="Deselect node, return to repository overview"
            className="shrink-0 rounded p-1.5 text-sm text-fg-muted hover:bg-surface-elevated hover:text-fg active:bg-surface-elevated"
          >
            ✕
          </button>
        </div>

        {selectedNode.data.filePath && (
          <p className="truncate font-mono text-xs text-fg-subtle">{selectedNode.data.filePath}</p>
        )}

        <div className="flex flex-col gap-1 text-xs text-fg-muted">
          <div className="flex justify-between">
            <span>Certainty</span>
            <span className={selectedNode.data.certainty === 'inferred' ? 'text-inferred' : 'text-deterministic'}>
              {selectedNode.data.certainty}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Verified</span>
            <span className="text-fg">{selectedNode.data.verified ? 'Yes' : 'No'}</span>
          </div>
          <div className="flex justify-between">
            <span>Source</span>
            <span className="truncate pl-2 text-fg">{selectedNode.data.provenanceSource}</span>
          </div>
        </div>

        <div>
          <p className="mb-1 text-xs font-medium text-fg-muted">Incoming ({relationships.incomingCount})</p>
          <ul className="flex flex-col gap-0.5">
            {incoming.slice(0, 8).map((edge) => (
              <li key={edge.id} className="truncate font-mono text-xs text-fg-subtle">
                {nodeById.get(edge.source)?.data.label ?? edge.source}
                <span className="text-fg-subtle/60"> · {edge.data?.edgeType}</span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <p className="mb-1 text-xs font-medium text-fg-muted">Outgoing ({relationships.outgoingCount})</p>
          <ul className="flex flex-col gap-0.5">
            {outgoing.slice(0, 8).map((edge) => (
              <li key={edge.id} className="truncate font-mono text-xs text-fg-subtle">
                {nodeById.get(edge.target)?.data.label ?? edge.target}
                <span className="text-fg-subtle/60"> · {edge.data?.edgeType}</span>
              </li>
            ))}
          </ul>
        </div>

        {repositoryId && (
          <NodeQuestionPanel
            key={selectedNode.id}
            nodeType={selectedNode.data.nodeType}
            history={history}
            isAsking={isAsking}
            onAsk={ask}
            onCancel={cancel}
            onClearHistory={clearHistory}
          />
        )}
      </aside>
    );
  }

  if (!repositoryId) {
    return (
      <aside className="flex h-full w-full flex-col border-l border-border bg-surface p-4">
        <p className="text-sm font-medium text-fg">Repository Overview</p>
        <p className="mt-2 text-xs text-fg-subtle">Select a repository to see its structure and metrics here.</p>
      </aside>
    );
  }

  if (isLoading) {
    return (
      <aside className="flex h-full w-full flex-col gap-3 border-l border-border bg-surface p-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
      </aside>
    );
  }

  if (isError || !repository) {
    return (
      <aside className="flex h-full w-full flex-col border-l border-border bg-surface p-4">
        <p className="text-sm font-medium text-fg">Repository Overview</p>
        <p className="mt-2 text-xs text-fg-subtle">Could not load this repository.</p>
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-full flex-col gap-3 border-l border-border bg-surface p-4">
      <div>
        <p className="text-sm font-medium text-fg">Repository Overview</p>
        <p className="mt-1 truncate font-mono text-xs text-fg-subtle">{repository.githubUrl}</p>
      </div>

      <div className="flex flex-col gap-1 text-xs text-fg-muted">
        <div className="flex justify-between">
          <span>Status</span>
          <span className="text-fg">{repository.status}</span>
        </div>
        {repository.status === 'ready' && (
          <div className="flex justify-between">
            <span>Files</span>
            <span className="text-fg">{repository.fileCount}</span>
          </div>
        )}
      </div>

      <p className="mt-auto text-xs text-fg-subtle">Select a node in the graph to inspect it.</p>
    </aside>
  );
}
