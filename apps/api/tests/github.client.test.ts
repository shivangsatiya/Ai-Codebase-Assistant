import { GitHubClient } from '../src/clients/github.client';
import { ForbiddenError, NotFoundError } from '../src/utils/errors';

function mockFetchOnce(response: { ok: boolean; status: number; json?: () => Promise<unknown> }): jest.Mock {
  const mockFetch = jest.fn().mockResolvedValue(response);
  global.fetch = mockFetch as unknown as typeof fetch;
  return mockFetch;
}

describe('GitHubClient - private repo support (Milestone 2, Task 4)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects a private repo when no userToken is supplied - the original Milestone 1 behavior, still correct with no GitHub connection', async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({
        full_name: 'owner/repo',
        default_branch: 'main',
        private: true,
        clone_url: 'https://github.com/owner/repo.git',
      }),
    });
    const client = new GitHubClient();

    await expect(client.fetchRepoInfo('https://github.com/owner/repo')).rejects.toThrow(ForbiddenError);
  });

  it('allows a private repo through when a userToken is supplied', async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({
        full_name: 'owner/repo',
        default_branch: 'main',
        private: true,
        clone_url: 'https://github.com/owner/repo.git',
      }),
    });
    const client = new GitHubClient();

    const result = await client.fetchRepoInfo('https://github.com/owner/repo', 'gho_realusertoken');

    expect(result.isPrivate).toBe(true);
  });

  it('a public repo is allowed through regardless of whether a userToken is supplied', async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({
        full_name: 'owner/repo',
        default_branch: 'main',
        private: false,
        clone_url: 'https://github.com/owner/repo.git',
      }),
    });
    const client = new GitHubClient();

    const result = await client.fetchRepoInfo('https://github.com/owner/repo', 'gho_realusertoken');

    expect(result.isPrivate).toBe(false);
  });

  it('the userToken is used for the API call, taking precedence over the server-wide token', async () => {
    const mockFetch = mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({ full_name: 'owner/repo', default_branch: 'main', private: false, clone_url: 'x' }),
    });
    const client = new GitHubClient('server-wide-token');

    await client.fetchRepoInfo('https://github.com/owner/repo', 'user-specific-token');

    const [, options] = mockFetch.mock.calls[0]!;
    expect((options as RequestInit).headers).toMatchObject({ Authorization: 'Bearer user-specific-token' });
  });

  it('falls back to the server-wide token when no userToken is supplied', async () => {
    const mockFetch = mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({ full_name: 'owner/repo', default_branch: 'main', private: false, clone_url: 'x' }),
    });
    const client = new GitHubClient('server-wide-token');

    await client.fetchRepoInfo('https://github.com/owner/repo');

    const [, options] = mockFetch.mock.calls[0]!;
    expect((options as RequestInit).headers).toMatchObject({ Authorization: 'Bearer server-wide-token' });
  });

  it('a userToken that does not grant access to the specific repo still results in NotFoundError, via GitHub API doing the real access control', async () => {
    // GitHub's own API returns 404 (not 403) for a private repo the
    // token can't see, indistinguishable from a genuinely nonexistent
    // repo - already-existing NotFoundError handling covers this
    // correctly with no new logic needed.
    mockFetchOnce({ ok: false, status: 404 });
    const client = new GitHubClient();

    await expect(
      client.fetchRepoInfo('https://github.com/owner/inaccessible-repo', 'token-without-access'),
    ).rejects.toThrow(NotFoundError);
  });
});
