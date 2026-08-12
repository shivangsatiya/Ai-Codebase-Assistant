import { memo } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import {
  Boxes,
  Folder,
  File,
  Box,
  Shapes,
  FunctionSquare,
  Server,
  Layers,
  Route,
  Database,
  Package,
  Zap,
  ListOrdered,
  Bell,
  Settings,
  ShieldCheck,
  CircleHelp,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import type { GraphNodeData } from '../../lib/graph-adapter';

const NODE_TYPE_ICONS: Record<string, typeof Boxes> = {
  repository: Boxes,
  folder: Folder,
  file: File,
  class: Box,
  interface: Shapes,
  function: FunctionSquare,
  method: FunctionSquare,
  service: Server,
  controller: Layers,
  route: Route,
  dbModel: Database,
  package: Package,
  cache: Zap,
  queue: ListOrdered,
  event: Bell,
  configuration: Settings,
  authComponent: ShieldCheck,
};

function GraphNodeComponent({ data, selected }: NodeProps<GraphNodeData>) {
  const Icon = NODE_TYPE_ICONS[data.nodeType] ?? CircleHelp;

  return (
    <div
      data-testid="graph-node"
      className={cn(
        'flex w-[180px] items-center gap-2 rounded-md border bg-surface-elevated px-3 py-2 text-xs',
        selected ? 'border-accent ring-2 ring-accent/40' : 'border-border',
        data.certainty === 'inferred' ? 'border-dashed' : 'border-solid',
      )}
      title={`${data.nodeType}: ${data.label}${data.certainty === 'inferred' ? ' (inferred)' : ''}`}
    >
      <Handle type="target" position={Position.Top} className="!bg-fg-subtle" />
      <Icon
        size={14}
        className={cn('shrink-0', data.certainty === 'inferred' ? 'text-inferred' : 'text-deterministic')}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-fg">{data.label}</p>
        <p className="truncate text-[10px] text-fg-subtle">{data.nodeType}</p>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-fg-subtle" />
    </div>
  );
}

export const GraphNode = memo(GraphNodeComponent);
export const nodeTypes = { graphNode: GraphNode };
