import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../../../test-utils/render';
import { RepositoryGraph } from '../RepositoryGraph';
import { useAuthStore } from '../../../stores/auth-store';
import { useGraphUiStore } from '../../../stores/graph-ui-store';

function mockFetchOnce(status: number, body: unknown): void {
  globalThis.fetch = vi.fn((url: string) => {
    // The cycles query always fires alongside the graph query once a
    // ready graph exists - route it to a real, correctly-shaped
    // response rather than reusing the graph body, which was producing
    // a genuine "Query data cannot be undefined" warning from a
    // mismatched mock, not a real component bug.
    if (typeof url === 'string' && url.includes('/graph/analysis/cycle-detection')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ algorithm: 'cycle-detection', result: { cycles: [], cycleCount: 0 } }),
      });
    }
    return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
  }) as unknown as typeof fetch;
}

const READY_GRAPH_BODY = {
  status: 'ready',
  commitSha: 'abc123',
  nodes: [
    {
      id: 'repository:repo-1',
      type: 'repository',
      label: 'Repository',
      filePath: null,
      metadata: {},
      provenance: {
        source: 'RepositoryIntelligencePipeline',
        sourceVersion: '1',
        certainty: 'deterministic',
        verified: true,
      },
    },
    {
      id: 'file:a.ts',
      type: 'file',
      label: 'a.ts',
      filePath: 'a.ts',
      metadata: {},
      provenance: { source: 'DeterministicExtractor', sourceVersion: '1', certainty: 'deterministic', verified: false },
    },
    {
      id: 'file:b.ts',
      type: 'file',
      label: 'b.ts',
      filePath: 'b.ts',
      metadata: {},
      provenance: { source: 'DeterministicExtractor', sourceVersion: '1', certainty: 'deterministic', verified: false },
    },
  ],
  edges: [
    {
      id: 'e1',
      source: 'repository:repo-1',
      target: 'file:a.ts',
      type: 'contains',
      metadata: {},
      provenance: { source: 'DeterministicExtractor', sourceVersion: '1', certainty: 'deterministic', verified: false },
    },
    {
      id: 'e2',
      source: 'repository:repo-1',
      target: 'file:b.ts',
      type: 'contains',
      metadata: {},
      provenance: { source: 'DeterministicExtractor', sourceVersion: '1', certainty: 'deterministic', verified: false },
    },
    {
      id: 'e3',
      source: 'file:a.ts',
      target: 'file:b.ts',
      type: 'imports',
      metadata: {},
      provenance: { source: 'DeterministicExtractor', sourceVersion: '1', certainty: 'deterministic', verified: false },
    },
  ],
};

describe('RepositoryGraph', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'token', isAuthenticated: true });
    useGraphUiStore.setState({ selectedNodeId: null });
  });

  afterEach(() => {
    useGraphUiStore.setState({ selectedNodeId: null });
  });

  it('shows a real loading indicator, not bare "Loading..." text', () => {
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => undefined)) as unknown as typeof fetch;

    renderWithProviders(<RepositoryGraph repositoryId="repo-1" />);

    expect(screen.queryByText(/^loading\.\.\.$/i)).not.toBeInTheDocument();
    expect(screen.getByText(/preparing the architecture graph/i)).toBeInTheDocument();
  });

  it('shows a clear error state with retry on graph load failure', async () => {
    mockFetchOnce(500, { error: { code: 'INTERNAL_ERROR', message: 'Could not load the graph' } });

    renderWithProviders(<RepositoryGraph repositoryId="repo-1" />);

    await waitFor(() => expect(screen.getByText(/could not load the graph/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('shows a real message, not a blank canvas, when no graph has been generated yet', async () => {
    mockFetchOnce(200, { status: 'not_generated', nodes: [], edges: [] });

    renderWithProviders(<RepositoryGraph repositoryId="repo-1" />);

    await waitFor(() => expect(screen.getByText(/no knowledge graph has been generated/i)).toBeInTheDocument());
  });

  it('shows a real message, not a blank canvas, for a graph with only the synthesized root and nothing else', async () => {
    mockFetchOnce(200, {
      status: 'ready',
      commitSha: 'abc',
      nodes: [READY_GRAPH_BODY.nodes[0]],
      edges: [],
    });

    renderWithProviders(<RepositoryGraph repositoryId="repo-1" />);

    await waitFor(() => expect(screen.getByText(/no explorable structure/i)).toBeInTheDocument());
  });

  it('renders real node labels once a real graph loads', async () => {
    mockFetchOnce(200, READY_GRAPH_BODY);

    renderWithProviders(<RepositoryGraph repositoryId="repo-1" />);

    await waitFor(() => expect(screen.getByText('a.ts')).toBeInTheDocument());
    expect(screen.getByText('b.ts')).toBeInTheDocument();
  });

  it('clicking a node updates the graph UI store with its stable id - never a copy of the node object', async () => {
    mockFetchOnce(200, READY_GRAPH_BODY);

    renderWithProviders(<RepositoryGraph repositoryId="repo-1" />);
    const nodeLabel = await screen.findByText('a.ts');

    fireEvent.click(nodeLabel);

    await waitFor(() => expect(useGraphUiStore.getState().selectedNodeId).toBe('file:a.ts'));
  });

  it('clicking the already-selected node deselects it', async () => {
    mockFetchOnce(200, READY_GRAPH_BODY);
    useGraphUiStore.setState({ selectedNodeId: 'file:a.ts' });

    renderWithProviders(<RepositoryGraph repositoryId="repo-1" />);
    const nodeLabel = await screen.findByText('a.ts');

    fireEvent.click(nodeLabel);

    await waitFor(() => expect(useGraphUiStore.getState().selectedNodeId).toBeNull());
  });

  it('CRITICAL: hovering a node triggers zero additional network requests - all relationship info comes from the already-fetched graph', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (typeof url === 'string' && url.includes('/graph/analysis/cycle-detection')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ algorithm: 'cycle-detection', result: { cycles: [], cycleCount: 0 } }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => READY_GRAPH_BODY });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderWithProviders(<RepositoryGraph repositoryId="repo-1" />);
    const nodeLabel = await screen.findByText('a.ts');

    const callCountBeforeHover = fetchMock.mock.calls.length;
    fireEvent.mouseEnter(nodeLabel);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetchMock.mock.calls.length).toBe(callCountBeforeHover);
  });

  it('hover shows real, locally-computed relationship counts', async () => {
    mockFetchOnce(200, READY_GRAPH_BODY);

    renderWithProviders(<RepositoryGraph repositoryId="repo-1" />);
    const nodeLabel = await screen.findByText('a.ts');

    fireEvent.mouseEnter(nodeLabel);

    await waitFor(() => expect(screen.getByText(/1 incoming/i)).toBeInTheDocument());
    expect(screen.getByText(/1 outgoing/i)).toBeInTheDocument();
  });
});
