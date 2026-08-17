import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test-utils/render';
import { AppShell } from '../AppShell';
import { useAuthStore } from '../../../stores/auth-store';
import { useWorkspaceUiStore } from '../../../stores/ui-store';
import { useGraphUiStore } from '../../../stores/graph-ui-store';

/**
 * A real, URL-aware fetch mock - AppShell is the first component in
 * this project's tests to render multiple, genuinely different
 * data-fetching children simultaneously (Sidebar's repository list,
 * WorkspaceCenter's single repository + lazy-loaded graph, Inspector's
 * own repository + graph fetches), so a single blanket mockResolvedValue
 * response (the established pattern for every other, single-component
 * test in this project) isn't enough here.
 */
function mockFetchByUrl(responses: Record<string, unknown>): void {
  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const [pattern, body] of Object.entries(responses)) {
      if (url.includes(pattern)) {
        return Promise.resolve({ ok: true, status: 200, json: async () => body });
      }
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  }) as unknown as typeof fetch;
}

function setMobileViewport(): void {
  globalThis.matchMedia = ((query: string) => {
    const target = new EventTarget();
    return {
      matches: false, // never matches (min-width: 768px) - a real mobile viewport
      media: query,
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
    };
  }) as typeof window.matchMedia;
}

const repo = {
  repositoryId: 'repo-1',
  githubUrl: 'https://github.com/lukeed/klona',
  status: 'ready',
  isPrivate: false,
  fileCount: 12,
};

describe('AppShell - mobile single-panel navigation', () => {
  const originalMatchMedia = globalThis.matchMedia;

  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'token', isAuthenticated: true, email: 'test@example.com' });
    useWorkspaceUiStore.setState({ mobilePanel: 'sidebar' });
    useGraphUiStore.setState({ selectedNodeId: null });
    setMobileViewport();
  });

  afterEach(() => {
    globalThis.matchMedia = originalMatchMedia;
  });

  it('shows only the sidebar (repository list) on mobile when no repository is selected in the URL', async () => {
    mockFetchByUrl({ '/api/repositories': { repositories: [repo] } });

    renderWithProviders(<AppShell />, { route: '/workspace', path: '/workspace/:repositoryId?' });

    await waitFor(() => expect(screen.getByText(/lukeed\/klona/i)).toBeInTheDocument());
    // The mobile 'main' panel's own back button is a real, distinct
    // signal that we're NOT showing the sidebar-only view - its
    // absence here is the actual assertion, not just checking sidebar
    // content is present (which alone wouldn't rule out it being
    // rendered twice, once per panel).
    expect(screen.queryByRole('button', { name: /repositories/i })).not.toBeInTheDocument();
  });

  it(
    'REGRESSION: auto-advances to the main panel on mobile when a repository is already selected via the ' +
      "URL - the exact scenario of following a deep link or refreshing mid-session, not just clicking through",
    async () => {
      mockFetchByUrl({
        '/api/repositories/repo-1/graph': { status: 'not_generated', nodes: [], edges: [] },
        '/api/repositories/repo-1': repo,
        '/api/repositories': { repositories: [repo] },
      });

      renderWithProviders(<AppShell />, { route: '/workspace/repo-1', path: '/workspace/:repositoryId?' });

      // The mobile main panel's own back button is real, direct proof
      // the auto-advance fired - not an assumption based on the
      // sidebar simply not being the default anymore.
      await waitFor(() => expect(screen.getByRole('button', { name: /repositories/i })).toBeInTheDocument());
    },
  );

  it('the mobile back button genuinely navigates away, not just toggling local panel state', async () => {
    mockFetchByUrl({
      '/api/repositories/repo-1/graph': { status: 'not_generated', nodes: [], edges: [] },
      '/api/repositories/repo-1': repo,
      '/api/repositories': { repositories: [repo] },
    });
    const user = userEvent.setup();

    renderWithProviders(<AppShell />, { route: '/workspace/repo-1', path: '/workspace/:repositoryId?' });
    const backButton = await screen.findByRole('button', { name: /repositories/i });
    await user.click(backButton);

    // A real navigation, not merely a local mobilePanel flip: this
    // matters because AppShell's own auto-advance effect watches the
    // URL's repositoryId directly - a local-only panel change (without
    // real navigation) would be immediately overridden right back to
    // 'main' by that same effect on the very next render, silently
    // breaking the back button. Proven here by the sidebar's own
    // content becoming visible again, which only happens once
    // repositoryId genuinely clears from the URL.
    await waitFor(() => expect(screen.getByText(/lukeed\/klona/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /repositories/i })).not.toBeInTheDocument();
  });

  it('selecting a node auto-advances to the inspector panel on mobile', async () => {
    const graphNode = {
      id: 'node-1',
      type: 'function',
      label: 'handleRequest',
      filePath: 'src/index.ts',
      metadata: {},
      provenance: { source: 'ast', sourceVersion: '1', certainty: 'deterministic', verified: true },
    };
    mockFetchByUrl({
      '/api/repositories/repo-1/graph': { status: 'ready', nodes: [graphNode], edges: [] },
      '/api/repositories/repo-1': repo,
      '/api/repositories': { repositories: [repo] },
    });

    renderWithProviders(<AppShell />, { route: '/workspace/repo-1', path: '/workspace/:repositoryId?' });
    await waitFor(() => expect(screen.getByRole('button', { name: /repositories/i })).toBeInTheDocument());

    useGraphUiStore.setState({ selectedNodeId: 'node-1' });

    // The inspector's own real testid, only ever rendered on the
    // branch where it actually finds the selected node in its already-
    // fetched graph data - direct, specific proof the panel genuinely
    // switched AND that Inspector itself resolved the real selected
    // node correctly, not just that some other, generic panel state
    // changed.
    await waitFor(() => expect(screen.getByTestId('inspector-panel')).toBeInTheDocument());
    expect(screen.getByText(/handleRequest/i)).toBeInTheDocument();
  });
});
