import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../../test-utils/render';
import { WorkspaceCenter } from '../WorkspaceCenter';
import { useAuthStore } from '../../../stores/auth-store';

function mockFetchOnce(status: number, body: unknown): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe('WorkspaceCenter', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'token', isAuthenticated: true });
  });

  it('prompts repository selection when no repositoryId is in the URL', () => {
    renderWithProviders(<WorkspaceCenter />, { route: '/workspace', path: '/workspace/:repositoryId?' });

    expect(screen.getByText(/select a repository/i)).toBeInTheDocument();
  });

  it('opens the correct repository directly via a deep link, without requiring prior navigation through the list', async () => {
    mockFetchOnce(200, {
      repositoryId: 'repo-1',
      githubUrl: 'https://github.com/a/b',
      status: 'ready',
      fileCount: 5,
      errorMessage: null,
      job: null,
    });

    renderWithProviders(<WorkspaceCenter />, { route: '/workspace/repo-1', path: '/workspace/:repositoryId?' });

    // WorkspaceCenter's own responsibility for the ready case is the
    // identifying header (section 18) - the graph itself is rendered by
    // RepositoryGraph, which has its own comprehensive, dedicated test
    // suite (RepositoryGraph.test.tsx) covering loading/error/empty/
    // success/selection/hover in depth; re-testing all of that here
    // through WorkspaceCenter would be redundant, not more thorough.
    await waitFor(() => expect(screen.getByText('a/b')).toBeInTheDocument());
  });

  it('shows a clear, honest "not found" message for an unknown or not-owned repository - the backend is the authority, this never guesses which case it is', async () => {
    mockFetchOnce(404, { error: { code: 'NOT_FOUND', message: 'Repository not found' } });

    renderWithProviders(<WorkspaceCenter />, {
      route: '/workspace/someone-elses-repo',
      path: '/workspace/:repositoryId?',
    });

    await waitFor(() => expect(screen.getByText(/repository not found/i)).toBeInTheDocument());
  });

  it('shows real indexing progress for a repository still being imported', async () => {
    mockFetchOnce(200, {
      repositoryId: 'repo-1',
      githubUrl: 'https://github.com/a/b',
      status: 'embedding',
      fileCount: 0,
      errorMessage: null,
      job: { stage: 'embedding', progress: 60, error: null },
    });

    renderWithProviders(<WorkspaceCenter />, { route: '/workspace/repo-1', path: '/workspace/:repositoryId?' });

    await waitFor(() => expect(screen.getByText(/indexing in progress/i)).toBeInTheDocument());
  });

  it('shows the real failure reason for a failed import', async () => {
    mockFetchOnce(200, {
      repositoryId: 'repo-1',
      githubUrl: 'https://github.com/a/b',
      status: 'failed',
      fileCount: 0,
      errorMessage: 'Repository exceeds the 15-file limit for indexing',
      job: null,
    });

    renderWithProviders(<WorkspaceCenter />, { route: '/workspace/repo-1', path: '/workspace/:repositoryId?' });

    await waitFor(() => expect(screen.getByText(/exceeds the 15-file limit/i)).toBeInTheDocument());
  });
});
