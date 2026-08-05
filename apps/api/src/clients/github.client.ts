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
  fetchRepoInfo(url: string, userToken?: string): Promise<GitHubRepoInfo>;
}

const GITHUB_URL_PATTERN = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(\.git)?\/?$/;

/**
 * Why validate against the GitHub API before attempting a clone, instead
 * of just trying `git clone` and seeing what happens?
 *
 * A malformed or non-existent URL should fail fast with a clear 422/404,
 * not tie up a clone process for 30 seconds before timing out.
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

  /**
   * Why does a userToken change whether a private repo is accepted,
   * rather than private repos being unconditionally rejected the way
   * Milestone 1 left them?
   *
   * Milestone 1's blanket rejection was correct for its own scope
   * (private repo support genuinely needed GitHub OAuth, which didn't
   * exist yet). Now that it does (Task 3), the right check isn't "is
   * this repo private" - it's "does the CALLER have their own
   * credential that can actually access it." If a userToken is supplied
   * and the repo is private, GitHub's own API does the real access
   * control: a token that can't see the repo gets a 404 here, already
   * handled correctly by the existing NotFoundError branch below - no
   * new authorization logic needed, GitHub does it for free.
   *
   * Why does userToken take precedence over the server-wide
   * githubToken, rather than being combined or falling back?
   *
   * The user's own token is scoped to what THEY can access (including
   * their private repos); the server-wide token is a generic
   * rate-limit-raising credential with no special access. Using the
   * user's token when available gets both the higher rate limit AND
   * correct private-repo access in one call - there's no scenario where
   * falling back to the weaker server token instead would be preferable.
   */
  async fetchRepoInfo(url: string, userToken?: string): Promise<GitHubRepoInfo> {
    const { owner, repo } = this.parseRepoUrl(url);

    const effectiveToken = userToken ?? this.githubToken;
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
    if (effectiveToken) {
      headers.Authorization = `Bearer ${effectiveToken}`;
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

    if (data.private && !userToken) {
      throw new ForbiddenError('This is a private repository - connect your GitHub account to import it');
    }

    return {
      fullName: data.full_name,
      defaultBranch: data.default_branch,
      isPrivate: data.private,
      cloneUrl: data.clone_url,
    };
  }
}
