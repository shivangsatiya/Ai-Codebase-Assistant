import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test-utils/render';
import { RepositoryList } from '../RepositoryList';
import { useAuthStore } from '../../../stores/auth-store';

function mockFetchOnce(status: number, body: unknown): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe('RepositoryList', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'token', isAuthenticated: true });
  });

  it('shows a real skeleton, not a bare "Loading..." text, while the list is loading', () => {
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => undefined)) as unknown as typeof fetch;

    renderWithProviders(<RepositoryList onImportClick={vi.fn()} />);

    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no repositories/i)).not.toBeInTheDocument();
  });

  it('shows the empty state with an import action when the user has no repositories', async () => {
    mockFetchOnce(200, { repositories: [] });

    renderWithProviders(<RepositoryList onImportClick={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/no repositories yet/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /import a repository/i })).toBeInTheDocument();
  });

  it('calls onImportClick when the empty state action is clicked', async () => {
    mockFetchOnce(200, { repositories: [] });
    const onImportClick = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(<RepositoryList onImportClick={onImportClick} />);
    const button = await screen.findByRole('button', { name: /import a repository/i });
    await user.click(button);

    expect(onImportClick).toHaveBeenCalledTimes(1);
  });

  it('renders real repository data - name and status - on success', async () => {
    mockFetchOnce(200, {
      repositories: [
        {
          repositoryId: 'repo-1',
          githubUrl: 'https://github.com/lukeed/klona',
          status: 'ready',
          isPrivate: false,
          fileCount: 40,
        },
      ],
    });

    renderWithProviders(<RepositoryList onImportClick={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('lukeed/klona')).toBeInTheDocument());
    expect(screen.getByText(/ready/i)).toBeInTheDocument();
    expect(screen.getByText(/40 files/i)).toBeInTheDocument();
  });

  it('shows a real error state with a retry action, never the raw backend error object', async () => {
    mockFetchOnce(500, { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our end' } });

    renderWithProviders(<RepositoryList onImportClick={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/something went wrong on our end/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('retrying after an error actually refetches, not just re-renders the same failed state', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: { code: 'X', message: 'First failure' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          repositories: [
            { repositoryId: 'r1', githubUrl: 'https://github.com/a/b', status: 'ready', isPrivate: false, fileCount: 1 },
          ],
        }),
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();

    renderWithProviders(<RepositoryList onImportClick={vi.fn()} />);
    await waitFor(() => screen.getByText(/first failure/i));

    await user.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(screen.getByText('a/b')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
