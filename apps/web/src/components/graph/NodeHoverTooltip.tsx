import type { FlowNode } from '../../lib/graph-adapter';
import type { NodeRelationships } from '../../lib/graph-relationships';

interface NodeHoverTooltipProps {
  node: FlowNode;
  relationships: NodeRelationships;
}

export function NodeHoverTooltip({ node, relationships }: NodeHoverTooltipProps) {
  return (
    <div className="pointer-events-none absolute bottom-4 left-4 z-10 rounded-md border border-border bg-surface-elevated px-3 py-2 text-xs shadow-lg">
      <p className="font-mono text-fg">{node.data.label}</p>
      <p className="text-fg-subtle">
        {node.data.nodeType} · {node.data.certainty}
      </p>
      <p className="mt-1 text-fg-muted">
        {relationships.incomingCount} incoming · {relationships.outgoingCount} outgoing
      </p>
    </div>
  );
}
