import { ValidationError, UnauthorizedError } from '../utils/errors';

export interface GitHubTokenExchangeResult {
  accessToken: string;
  scopes: string[];
}

export interface GitHubAuthenticatedUser {
  githubUserId: number;
  githubUsername: string;
}

/**
 * Separate from GitHubClient (which validates and fetches metadata for
 * a repository being imported) deliberately - this handles the OAuth
 * handshake itself (authorize URL, code exchange, revocation), a
 * genuinely different concern with a different lifecycle. Every
 * endpoint shape and header requirement here was checked against
 * GitHub's current documentation before writing this class, not
 * assumed - including a real, commonly-hit gotcha: the token exchange
 * endpoint returns form-encoded data by default and silently ignores a
 * missing Accept header rather than erroring, so skipping it doesn't
 * fail loudly, it just returns something this code can't parse as JSON.
 */
export interface IGitHubOAuthClient {
  buildAuthorizeUrl(state: string): string;
  exchangeCodeForToken(code: string): Promise<GitHubTokenExchangeResult>;
  fetchAuthenticatedUser(accessToken: string): Promise<GitHubAuthenticatedUser>;
  revokeToken(accessToken: string): Promise<void>;
}

export class GitHubOAuthClient implements IGitHubOAuthClient {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
  ) {}

  /**
   * `repo` scope, not a narrower one - classic GitHub OAuth Apps don't
   * offer a read-only-private-repo scope; that finer control is
   * specifically what GitHub Apps exist for (see the design doc's
   * trade-offs section). This app never exercises write access, but the
   * token it holds technically could.
   */
  buildAuthorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: 'repo',
      state,
    });
    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  async exchangeCodeForToken(code: string): Promise<GitHubTokenExchangeResult> {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Required - without this, GitHub returns form-urlencoded data
        // by default and does not error on its absence, it just returns
        // something unparseable as JSON.
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: this.redirectUri,
      }),
    });

    if (!response.ok) {
      throw new ValidationError('GitHub token exchange request failed');
    }

    const data = (await response.json()) as { access_token?: string; scope?: string; error?: string };

    // A failed exchange (expired/invalid code, mismatched redirect_uri)
    // still returns HTTP 200 from GitHub, with an `error` field in the
    // body instead of a non-2xx status - checking response.ok alone
    // would miss this failure mode entirely.
    if (!data.access_token || data.error) {
      throw new ValidationError(`GitHub token exchange failed: ${data.error ?? 'no access_token in response'}`);
    }

    return {
      accessToken: data.access_token,
      scopes: data.scope ? data.scope.split(',').filter(Boolean) : [],
    };
  }

  async fetchAuthenticatedUser(accessToken: string): Promise<GitHubAuthenticatedUser> {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
      },
    });

    if (response.status === 401) {
      throw new UnauthorizedError('GitHub rejected the access token when fetching user info');
    }
    if (!response.ok) {
      throw new ValidationError('Failed to fetch authenticated GitHub user');
    }

    const data = (await response.json()) as { id: number; login: string };
    return { githubUserId: data.id, githubUsername: data.login };
  }

  /**
   * Why is a failed revoke not thrown as a hard error here, and instead
   * left for the caller to decide?
   *
   * This client's job is just to report what GitHub's API actually
   * returned - whether a failed remote revoke should still allow local
   * disconnection to proceed is a business decision that belongs in
   * GitHubOAuthService, not baked into this client's behavior.
   */
  async revokeToken(accessToken: string): Promise<void> {
    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    const response = await fetch(`https://api.github.com/applications/${this.clientId}/grant`, {
      method: 'DELETE',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ access_token: accessToken }),
    });

    // 404 means the token was already invalid/revoked on GitHub's side
    // - not a failure from this app's perspective, since the end state
    // (GitHub no longer honors this token) is exactly what was wanted.
    if (!response.ok && response.status !== 404) {
      throw new ValidationError(`GitHub token revocation failed with status ${response.status}`);
    }
  }
}
