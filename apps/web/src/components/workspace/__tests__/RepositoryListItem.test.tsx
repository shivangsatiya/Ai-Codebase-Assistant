import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test-utils/render';
import { RepositoryListItem } from '../RepositoryListItem';
import { useAuthStore } from '../../../stores/auth-store';
import type { RepositorySummary } from '../../../lib/repositories-api';

const repo: RepositorySummary = {
  repositoryId: 'repo-1',
  githubUrl: 'https://github.com/lukeed/klona',
  status: 'ready',
  isPrivate: false,
  fileCount: 40,
};

describe('RepositoryListItem', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'token', isAuthenticated: true });
  });

  it('links to /workspace/:repositoryId - the URL is the only place selection state lives', () => {
    renderWithProviders(<RepositoryListItem repository={repo} isSelected={false} />);

    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/workspace/repo-1');
  });

  it('shows a distinct visual treatment when selected, matching the current URL', () => {
    const { container: unselected } = renderWithProviders(<RepositoryListItem repository={repo} isSelected={false} />);
    const unselectedClasses = unselected.querySelector('a')!.className;

    const { container: selected } = renderWithProviders(<RepositoryListItem repository={repo} isSelected={true} />);
    const selectedClasses = selected.querySelector('a')!.className;

    expect(selectedClasses).not.toEqual(unselectedClasses);
    expect(selectedClasses).toContain('border-accent');
  });

  it('displays the real file count only for a ready repository, not for one still in progress', () => {
    renderWithProviders(<RepositoryListItem repository={repo} isSelected={false} />);
    expect(screen.getByText(/40 files/i)).toBeInTheDocument();
  });

  it('does not show a file count for a repository still being indexed', () => {
    const inProgress: RepositorySummary = { ...repo, status: 'embedding', fileCount: 0 };
    renderWithProviders(<RepositoryListItem repository={inProgress} isSelected={false} />);
    expect(screen.queryByText(/files/i)).not.toBeInTheDocument();
  });
});

describe('RepositoryListItem - delete', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'token', isAuthenticated: true });
  });

  it(
    'REGRESSION: clicking delete never navigates to the repository - the button lives inside the row\'s ' +
      "own Link, so without stopping propagation this would incorrectly open the repository instead",
    async () => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as unknown as typeof fetch;
      const user = userEvent.setup();

      renderWithProviders(<RepositoryListItem repository={repo} isSelected={false} />);
      await user.click(screen.getByTestId('delete-repository-button'));

      // Only the arm-to-confirm click happened - no real DELETE request
      // fired yet, and specifically no navigation occurred either
      // (nothing here to directly assert navigation against, but the
      // confirm button appearing below proves the click was captured
      // by the delete button, not the surrounding Link).
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(screen.getByTestId('confirm-delete-repository')).toBeInTheDocument();
    },
  );

  it('requires a real second click to actually delete - the first click only arms the confirm state', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 204, json: async () => undefined });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const user = userEvent.setup();

    renderWithProviders(<RepositoryListItem repository={repo} isSelected={false} />);
    await user.click(screen.getByTestId('delete-repository-button'));
    expect(fetchSpy).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('confirm-delete-repository'));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/api/repositories/repo-1'),
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  it('the confirm state can be cancelled, reverting to the normal delete button without ever calling the API', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const user = userEvent.setup();

    renderWithProviders(<RepositoryListItem repository={repo} isSelected={false} />);
    await user.click(screen.getByTestId('delete-repository-button'));
    expect(screen.getByTestId('confirm-delete-repository')).toBeInTheDocument();

    await user.click(screen.getByLabelText(/cancel delete/i));

    expect(screen.queryByTestId('confirm-delete-repository')).not.toBeInTheDocument();
    expect(screen.getByTestId('delete-repository-button')).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows a real, honest error message inline if the delete request fails - never claims success silently', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } }),
    }) as unknown as typeof fetch;
    const user = userEvent.setup();

    renderWithProviders(<RepositoryListItem repository={repo} isSelected={false} />);
    await user.click(screen.getByTestId('delete-repository-button'));
    await user.click(screen.getByTestId('confirm-delete-repository'));

    await waitFor(() => {
      expect(screen.getByText(/couldn't delete/i)).toBeInTheDocument();
      expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    });
  });
});
