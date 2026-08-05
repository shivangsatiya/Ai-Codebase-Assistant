import { ValidationError, ForbiddenError, NotFoundError } from '../utils/errors';

export interface GitHubRepoInfo {
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  cloneUrl: string;
}

/**
 * Extracted so RepositoryImportService can depend on this interface
 * rather than the concrete GitHubClient class - the same pattern used
 * throughout this project (IEmbeddingProvider, IChunkRepository, etc.)
 * for exactly the same reason: it lets tests inject a fake that never
 * makes a real network call, without which RepositoryImportService
 * (the most complex orchestration class in the codebase) had no unit
 * test coverage at all.
 */
export interface IGitHubClient {
  parseRepoUrl(url: string): { owner: string; repo: string };
  fetchRepoInfo(url: string): Promise<GitHubRepoInfo>;
}

const GITHUB_URL_PATTERN = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(\.git)?\/?$/;

/**
 * Why validate against the GitHub API before attempting a clone, instead
 * of just trying `git clone` and seeing what happens?
 *
 * A malformed or non-existent URL should fail fast with a clear 422/404,
 * not tie up a clone process for 30 seconds before timing out. And a
 * private repo needs to be rejected explicitly in Milestone 1 (private
 * repo support is a Milestone 2 feature requiring GitHub App auth) rather
 * than failing deep inside the clone with a confusing git auth error.
 */
export class GitHubClient implements IGitHubClient {
  constructor(private readonly githubToken?: string) {}

  parseRepoUrl(url: string): { owner: string; repo: string } {
    const match = GITHUB_URL_PATTERN.exec(url.trim());
    if (!match) {
      throw new ValidationError('Must be a valid GitHub repository URL, e.g. https://github.com/owner/repo');
    }
    const owner = match[1];
    const repo = match[2];
    if (!owner || !repo) {
      throw new ValidationError('Must be a valid GitHub repository URL, e.g. https://github.com/owner/repo');
    }
    return { owner, repo };
  }

  async fetchRepoInfo(url: string): Promise<GitHubRepoInfo> {
    const { owner, repo } = this.parseRepoUrl(url);

    // Authenticated requests get 5000/hour instead of the 60/hour
    // unauthenticated limit, which is also shared across everyone behind
    // the same IP (a home router, office network, etc.) - a token isn't
    // GitHub OAuth (that's Milestone 2's user-facing login), just a
    // server-side credential for calling GitHub's own API reliably.
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
    if (this.githubToken) {
      headers.Authorization = `Bearer ${this.githubToken}`;
    }

    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });

    if (response.status === 404) {
      throw new NotFoundError('Repository not found on GitHub');
    }

    if (!response.ok) {
      throw new ValidationError(`Could not verify repository (GitHub API returned ${response.status})`);
    }

    const data = (await response.json()) as {
      full_name: string;
      default_branch: string;
      private: boolean;
      clone_url: string;
    };

    if (data.private) {
      throw new ForbiddenError('Private repositories are not supported yet');
    }

    return {
      fullName: data.full_name,
      defaultBranch: data.default_branch,
      isPrivate: data.private,
      cloneUrl: data.clone_url,
    };
  }
}
