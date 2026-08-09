import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../../test-utils/render';
import { RepositoryListItem } from '../RepositoryListItem';
import type { RepositorySummary } from '../../../lib/repositories-api';

const repo: RepositorySummary = {
  repositoryId: 'repo-1',
  githubUrl: 'https://github.com/lukeed/klona',
  status: 'ready',
  isPrivate: false,
  fileCount: 40,
};

describe('RepositoryListItem', () => {
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
