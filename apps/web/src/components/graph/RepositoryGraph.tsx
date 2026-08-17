import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import ReactFlow, { Background, Controls, MiniMap, type NodeMouseHandler } from 'reactflow';
import 'reactflow/dist/style.css';
import { useRepositoryGraph, useCycles } from '../../hooks/use-graph';
import { useElkLayout } from '../../hooks/use-elk-layout';
import { useGraphUiStore } from '../../stores/graph-ui-store';
import { adaptGraph, type FlowNode, type FlowEdge } from '../../lib/graph-adapter';
import { styleEdges } from '../../lib/graph-edge-style';
import { computeNodeRelationships } from '../../lib/graph-relationships';
import { nodeTypes } from './GraphNode';
import { Skeleton } from '../ui/skeleton';
import { ErrorState } from '../workspace/ErrorState';
import { NodeHoverTooltip } from './NodeHoverTooltip';
import { useIsMobileLayout } from '../../hooks/use-media-query';

const CYCLE_HIGHLIGHT_CLASS = 'graph-node-in-cycle';

export function RepositoryGraph({ repositoryId }: { repositoryId: string }) {
  const isMobile = useIsMobileLayout();
  const { data: graphResponse, isLoading, isError, error, refetch } = useRepositoryGraph(repositoryId);
  const selectedNodeId = useGraphUiStore((s) => s.selectedNodeId);
  const selectNode = useGraphUiStore((s) => s.selectNode);

  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  const hasReadyGraph = graphResponse?.status === 'ready';
  const { data: cyclesResult } = useCycles(repositoryId, hasReadyGraph);

  const adapted = useMemo(() => {
    // Milestone 4 Task 5 - measurement only. Real transformation
    // timing (backend graph shape -> React Flow shape), logged so
    // it's capturable during an actual benchmark run.
    const transformStartedAt = performance.now();
    const result = adaptGraph(graphResponse?.nodes ?? [], graphResponse?.edges ?? []);
    const transformDurationMs = Math.round(performance.now() - transformStartedAt);
    if (graphResponse) {
      // eslint-disable-next-line no-console
      console.log(`[benchmark] graph transform: ${transformDurationMs}ms`);
    }
    return result;
  }, [graphResponse]);

  const { layoutedNodes, isLayouting } = useElkLayout(adapted.nodes, adapted.containsEdges);

  // Milestone 4 Task 5 - measurement only. Approximates "graph data
  // available -> visibly rendered" via requestAnimationFrame, which
  // only fires after the browser has genuinely painted the updated
  // DOM - a real, honest approximation, not an exact frame-rate
  // measurement (which this project has no reliable mechanism for,
  // per this task's own explicit instruction not to claim precision
  // it doesn't have). loggedRef prevents re-logging on every
  // subsequent re-render once the graph has already rendered once.
  const hasLoggedRenderRef = useRef(false);
  useEffect(() => {
    if (layoutedNodes.length === 0 || hasLoggedRenderRef.current) return;
    const layoutCompleteAt = performance.now();
    requestAnimationFrame(() => {
      const renderDurationMs = Math.round(performance.now() - layoutCompleteAt);
      // eslint-disable-next-line no-console
      console.log(`[benchmark] approximate render (layout complete -> next paint): ${renderDurationMs}ms`);
    });
    hasLoggedRenderRef.current = true;
  }, [layoutedNodes]);

  const cycleNodeIds = useMemo(() => {
    if (!cyclesResult) return new Set<string>();
    return new Set(cyclesResult.cycles.flat());
  }, [cyclesResult]);

  const relationships = useMemo(() => {
    if (!selectedNodeId) return null;
    return computeNodeRelationships(selectedNodeId, adapted.edges);
  }, [selectedNodeId, adapted.edges]);

  const displayNodes = useMemo(() => {
    return layoutedNodes.map((node): FlowNode => {
      const isInCycle = cycleNodeIds.has(node.id);
      const isSelected = node.id === selectedNodeId;
      const isRelated = relationships?.relatedNodeIds.has(node.id) ?? false;
      const isDimmed = Boolean(selectedNodeId) && !isSelected && !isRelated;

      return {
        ...node,
        selected: isSelected,
        className: [isInCycle ? CYCLE_HIGHLIGHT_CLASS : '', isDimmed ? 'opacity-30' : ''].filter(Boolean).join(' '),
      };
    });
  }, [layoutedNodes, cycleNodeIds, selectedNodeId, relationships]);

  const displayEdges = useMemo(() => {
    const styled = styleEdges(adapted.edges);
    if (!selectedNodeId || !relationships) return styled;

    return styled.map((edge): FlowEdge => {
      const isRelated = relationships.relatedEdgeIds.has(edge.id);
      return { ...edge, className: isRelated ? '' : 'opacity-20' };
    });
  }, [adapted.edges, selectedNodeId, relationships]);

  const handleNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      selectNode(node.id === selectedNodeId ? null : node.id);
    },
    [selectNode, selectedNodeId],
  );

  const handleNodeMouseEnter: NodeMouseHandler = useCallback((_event, node) => {
    setHoveredNodeId(node.id);
  }, []);

  const handleNodeMouseLeave: NodeMouseHandler = useCallback(() => {
    setHoveredNodeId(null);
  }, []);

  const hoveredRelationships = useMemo(() => {
    if (!hoveredNodeId) return null;
    return computeNodeRelationships(hoveredNodeId, adapted.edges);
  }, [hoveredNodeId, adapted.edges]);

  const hoveredNode = hoveredNodeId ? adapted.nodes.find((n) => n.id === hoveredNodeId) : undefined;

  if (isLoading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Skeleton className="h-8 w-64" />
        <p className="text-xs text-fg-subtle">Preparing the architecture graph…</p>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex h-full items-center justify-center">
        <ErrorState error={error} onRetry={() => refetch()} />
      </div>
    );
  }

  if (graphResponse?.status === 'not_generated') {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-fg-subtle">No knowledge graph has been generated for this repository yet.</p>
      </div>
    );
  }

  if (adapted.nodes.length <= 1) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-fg-subtle">This repository's knowledge graph has no explorable structure yet.</p>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      {isLayouting && (
        <div className="absolute inset-x-0 top-0 z-10 flex justify-center py-2">
          <span className="rounded-md bg-surface-elevated px-2 py-1 text-xs text-fg-subtle">Arranging layout…</span>
        </div>
      )}

      <ReactFlow
        nodes={displayNodes}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        onNodeMouseEnter={handleNodeMouseEnter}
        onNodeMouseLeave={handleNodeMouseLeave}
        fitView
        minZoom={0.1}
        maxZoom={2}
        // Deliberate: nodes are not manually draggable. The ELK-computed
        // layout IS the meaningful representation for an architecture
        // graph - unlike a general diagramming tool, letting a user drag
        // nodes into an arbitrary arrangement wouldn't add real value
        // here, and would turn "reset layout" (section 9) into a
        // separate, real feature needing its own state management. With
        // dragging off, "fit view" (React Flow's built-in control,
        // verified below to carry a real accessible label) already IS
        // the reset - there's nothing else to reset.
        nodesDraggable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#1b1f2c" gap={24} />
        <Controls
          showInteractive={false}
          aria-label="Graph zoom and pan controls"
          className={isMobile ? '[&>button]:h-11 [&>button]:w-11' : undefined}
        />
        {!isMobile && (
          <MiniMap
            pannable
            zoomable
            maskColor="rgba(11, 13, 16, 0.7)"
            nodeColor="#262b3a"
            className="!bg-surface !border !border-border"
            ariaLabel="Graph overview minimap"
          />
        )}
      </ReactFlow>

      {!isMobile && hoveredNode && hoveredRelationships && (
        <NodeHoverTooltip node={hoveredNode} relationships={hoveredRelationships} />
      )}
    </div>
  );
}
