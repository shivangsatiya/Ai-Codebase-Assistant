import { GitHubOAuthClient } from '../src/clients/github-oauth.client';
import { ValidationError, UnauthorizedError } from '../src/utils/errors';

function mockFetchOnce(response: { ok: boolean; status: number; json?: () => Promise<unknown> }): jest.Mock {
  const mockFetch = jest.fn().mockResolvedValue(response);
  global.fetch = mockFetch as unknown as typeof fetch;
  return mockFetch;
}

describe('GitHubOAuthClient - buildAuthorizeUrl', () => {
  it('includes the client id, redirect uri, repo scope, and the given state', () => {
    const client = new GitHubOAuthClient('client-123', 'secret', 'https://example.com/callback');

    const url = client.buildAuthorizeUrl('state-abc');

    expect(url).toContain('https://github.com/login/oauth/authorize');
    expect(url).toContain('client_id=client-123');
    expect(url).toContain('scope=repo');
    expect(url).toContain('state=state-abc');
    expect(url).toContain(encodeURIComponent('https://example.com/callback'));
  });
});

describe('GitHubOAuthClient - exchangeCodeForToken', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends the Accept application/json header - without it, GitHub silently returns form-encoded data instead of erroring', async () => {
    const mockFetch = mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'gho_realtoken', scope: 'repo', token_type: 'bearer' }),
    });
    const client = new GitHubOAuthClient('id', 'secret', 'https://example.com/callback');

    await client.exchangeCodeForToken('a-code');

    const [, options] = mockFetch.mock.calls[0]!;
    expect((options as RequestInit).headers).toMatchObject({ Accept: 'application/json' });
  });

  it('parses a successful exchange into accessToken and a scopes array', async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'gho_realtoken', scope: 'repo,read:user', token_type: 'bearer' }),
    });
    const client = new GitHubOAuthClient('id', 'secret', 'https://example.com/callback');

    const result = await client.exchangeCodeForToken('a-code');

    expect(result.accessToken).toBe('gho_realtoken');
    expect(result.scopes).toEqual(['repo', 'read:user']);
  });

  it('throws when GitHub returns a 200 with an error field - a real gotcha, since response.ok alone would miss this', async () => {
    // GitHub's token exchange returns HTTP 200 even for a failed
    // exchange (expired code, mismatched redirect_uri), with the
    // failure communicated via an error field in the body instead of
    // a non-2xx status.
    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({ error: 'bad_verification_code', error_description: 'The code passed is incorrect.' }),
    });
    const client = new GitHubOAuthClient('id', 'secret', 'https://example.com/callback');

    await expect(client.exchangeCodeForToken('bad-code')).rejects.toThrow(ValidationError);
  });

  it('throws when the response is missing access_token entirely, even without an explicit error field', async () => {
    mockFetchOnce({ ok: true, status: 200, json: async () => ({}) });
    const client = new GitHubOAuthClient('id', 'secret', 'https://example.com/callback');

    await expect(client.exchangeCodeForToken('a-code')).rejects.toThrow(ValidationError);
  });

  it('treats an empty scope string as an empty array, not an array containing one empty string', async () => {
    mockFetchOnce({ ok: true, status: 200, json: async () => ({ access_token: 'gho_x', scope: '' }) });
    const client = new GitHubOAuthClient('id', 'secret', 'https://example.com/callback');

    const result = await client.exchangeCodeForToken('a-code');

    expect(result.scopes).toEqual([]);
  });
});

describe('GitHubOAuthClient - fetchAuthenticatedUser', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends the token as a Bearer Authorization header', async () => {
    const mockFetch = mockFetchOnce({ ok: true, status: 200, json: async () => ({ id: 42, login: 'octocat' }) });
    const client = new GitHubOAuthClient('id', 'secret', 'https://example.com/callback');

    await client.fetchAuthenticatedUser('gho_realtoken');

    const [, options] = mockFetch.mock.calls[0]!;
    expect((options as RequestInit).headers).toMatchObject({ Authorization: 'Bearer gho_realtoken' });
  });

  it('maps GitHub id and login fields to githubUserId and githubUsername', async () => {
    mockFetchOnce({ ok: true, status: 200, json: async () => ({ id: 42, login: 'octocat' }) });
    const client = new GitHubOAuthClient('id', 'secret', 'https://example.com/callback');

    const user = await client.fetchAuthenticatedUser('gho_realtoken');

    expect(user).toEqual({ githubUserId: 42, githubUsername: 'octocat' });
  });

  it('throws UnauthorizedError specifically on a 401 (an invalid or revoked token), distinct from other failures', async () => {
    mockFetchOnce({ ok: false, status: 401 });
    const client = new GitHubOAuthClient('id', 'secret', 'https://example.com/callback');

    await expect(client.fetchAuthenticatedUser('a-bad-token')).rejects.toThrow(UnauthorizedError);
  });
});

describe('GitHubOAuthClient - revokeToken', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends Basic auth built from the client id and secret', async () => {
    const mockFetch = mockFetchOnce({ ok: true, status: 204 });
    const client = new GitHubOAuthClient('my-client-id', 'my-secret', 'https://example.com/callback');

    await client.revokeToken('gho_token');

    const [, options] = mockFetch.mock.calls[0]!;
    const expectedAuth = `Basic ${Buffer.from('my-client-id:my-secret').toString('base64')}`;
    expect((options as RequestInit).headers).toMatchObject({ Authorization: expectedAuth });
  });

  it('does not throw on a 404 - the token was already invalid on GitHub side, which is the desired end state anyway', async () => {
    mockFetchOnce({ ok: false, status: 404 });
    const client = new GitHubOAuthClient('id', 'secret', 'https://example.com/callback');

    await expect(client.revokeToken('already-gone-token')).resolves.not.toThrow();
  });

  it('throws on other failure statuses', async () => {
    mockFetchOnce({ ok: false, status: 500 });
    const client = new GitHubOAuthClient('id', 'secret', 'https://example.com/callback');

    await expect(client.revokeToken('a-token')).rejects.toThrow(ValidationError);
  });
});
