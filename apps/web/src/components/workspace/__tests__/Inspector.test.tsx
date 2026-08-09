import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../../test-utils/render';
import { Inspector } from '../Inspector';
import { useAuthStore } from '../../../stores/auth-store';

function mockFetchOnce(status: number, body: unknown): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe('Inspector', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'token', isAuthenticated: true });
  });

  it('shows the "select a repository" message when no repositoryId is in the URL', () => {
    renderWithProviders(<Inspector />, { route: '/workspace', path: '/workspace/:repositoryId?' });

    expect(screen.getByText(/select a repository/i)).toBeInTheDocument();
  });

  it('REGRESSION: does NOT show "select a repository" while a genuinely-selected repository is still loading - a real bug found from a live screenshot, where both states were being conflated', () => {
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => undefined)) as unknown as typeof fetch;

    renderWithProviders(<Inspector />, { route: '/workspace/repo-1', path: '/workspace/:repositoryId?' });

    expect(screen.queryByText(/select a repository/i)).not.toBeInTheDocument();
  });

  it('shows the real repository overview once loaded', async () => {
    mockFetchOnce(200, {
      repositoryId: 'repo-1',
      githubUrl: 'https://github.com/a/b',
      status: 'ready',
      fileCount: 12,
      errorMessage: null,
      job: null,
    });

    renderWithProviders(<Inspector />, { route: '/workspace/repo-1', path: '/workspace/:repositoryId?' });

    await waitFor(() => expect(screen.getByText('https://github.com/a/b')).toBeInTheDocument());
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('shows a distinct, honest error message when the repository fails to load - not the misleading "select a repository" text', async () => {
    mockFetchOnce(404, { error: { code: 'NOT_FOUND', message: 'Repository not found' } });

    renderWithProviders(<Inspector />, { route: '/workspace/repo-1', path: '/workspace/:repositoryId?' });

    await waitFor(() => expect(screen.getByText(/could not load this repository/i)).toBeInTheDocument());
    expect(screen.queryByText(/select a repository/i)).not.toBeInTheDocument();
  });
});
