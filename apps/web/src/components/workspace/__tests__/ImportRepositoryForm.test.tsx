import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test-utils/render';
import { ImportRepositoryForm } from '../ImportRepositoryForm';
import { useAuthStore } from '../../../stores/auth-store';

describe('ImportRepositoryForm', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'token', isAuthenticated: true });
  });

  it('shows a validation error and never calls fetch for a non-GitHub URL, without waiting on a round trip', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const user = userEvent.setup();

    renderWithProviders(<ImportRepositoryForm onDone={vi.fn()} />);
    await user.type(screen.getByPlaceholderText(/github\.com/i), 'not-a-real-url');
    await user.click(screen.getByRole('button', { name: /^import$/i }));

    expect(screen.getByText(/valid github\.com repository url/i)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('disables the submit button while an import is in progress - prevents duplicate submissions', async () => {
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => undefined)) as unknown as typeof fetch;
    const user = userEvent.setup();

    renderWithProviders(<ImportRepositoryForm onDone={vi.fn()} />);
    await user.type(screen.getByPlaceholderText(/github\.com/i), 'https://github.com/owner/repo');
    await user.click(screen.getByRole('button', { name: /^import$/i }));

    expect(screen.getByRole('button', { name: /importing/i })).toBeDisabled();
  });

  it('on success, calls onDone - never claims the repository is ready, only that the import was accepted', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ repositoryId: 'repo-1', status: 'queued', jobId: 'job-1' }),
    }) as unknown as typeof fetch;
    const onDone = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(<ImportRepositoryForm onDone={onDone} />, {
      route: '/workspace',
      path: '/workspace/:repositoryId?',
    });
    await user.type(screen.getByPlaceholderText(/github\.com/i), 'https://github.com/owner/repo');
    await user.click(screen.getByRole('button', { name: /^import$/i }));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it('on failure, shows the real backend error message and does NOT call onDone - the form stays open so the user can retry', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ error: { code: 'VALIDATION_ERROR', message: 'This repository could not be found' } }),
    }) as unknown as typeof fetch;
    const onDone = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(<ImportRepositoryForm onDone={onDone} />);
    await user.type(screen.getByPlaceholderText(/github\.com/i), 'https://github.com/owner/does-not-exist');
    await user.click(screen.getByRole('button', { name: /^import$/i }));

    await waitFor(() => expect(screen.getByText(/could not be found/i)).toBeInTheDocument());
    expect(onDone).not.toHaveBeenCalled();
  });

  it('calls onDone when Cancel is clicked, without submitting anything', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const onDone = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(<ImportRepositoryForm onDone={onDone} />);
    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
