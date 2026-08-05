import { GitHubOAuthService } from '../src/services/github-oauth.service';
import type { IGitHubOAuthClient, GitHubTokenExchangeResult, GitHubAuthenticatedUser } from '../src/clients/github-oauth.client';
import type {
  IGitHubConnectionRepository,
  UpsertConnectionInput,
} from '../src/repositories/github-connection.repository';
import type { IGitHubOAuthStateRepository } from '../src/repositories/github-oauth-state.repository';
import type { ITokenEncryptor, EncryptedValue } from '../src/utils/token-encryptor';
import type { GitHubConnectionDocument } from '../src/models/github-connection.model';
import type { GitHubOAuthStateDocument } from '../src/models/github-oauth-state.model';
import { UnauthorizedError, NotFoundError } from '../src/utils/errors';

function makeConnectionDoc(overrides: Partial<GitHubConnectionDocument> = {}): GitHubConnectionDocument {
  return {
    encryptedToken: 'ciphertext',
    iv: 'iv',
    authTag: 'tag',
    keyVersion: 1,
    githubUsername: 'octocat',
    ...overrides,
  } as unknown as GitHubConnectionDocument;
}

class FakeGitHubOAuthClient implements IGitHubOAuthClient {
  public revokeCalledWith: string | null = null;
  public exchangeAttempts = 0;

  constructor(
    private readonly exchangeResult: GitHubTokenExchangeResult | 'fail-once-then-succeed' | 'always-fail',
    private readonly userResult: GitHubAuthenticatedUser = { githubUserId: 1, githubUsername: 'octocat' },
    private readonly revokeShouldFail = false,
  ) {}

  buildAuthorizeUrl(state: string): string {
    return `https://github.com/login/oauth/authorize?state=${state}`;
  }

  async exchangeCodeForToken(_code: string): Promise<GitHubTokenExchangeResult> {
    this.exchangeAttempts++;
    if (this.exchangeResult === 'always-fail') {
      throw new Error('Simulated GitHub API failure');
    }
    if (this.exchangeResult === 'fail-once-then-succeed') {
      if (this.exchangeAttempts === 1) throw new Error('Simulated transient failure');
      return { accessToken: 'gho_recoveredtoken', scopes: ['repo'] };
    }
    return this.exchangeResult;
  }

  async fetchAuthenticatedUser(_accessToken: string): Promise<GitHubAuthenticatedUser> {
    return this.userResult;
  }

  async revokeToken(accessToken: string): Promise<void> {
    this.revokeCalledWith = accessToken;
    if (this.revokeShouldFail) {
      throw new Error('Simulated revoke failure');
    }
  }
}

class FakeGitHubConnectionRepository implements IGitHubConnectionRepository {
  public upserted: UpsertConnectionInput[] = [];
  public deletedUserIds: string[] = [];
  private connections = new Map<string, GitHubConnectionDocument>();

  seed(userId: string, doc: GitHubConnectionDocument): void {
    this.connections.set(userId, doc);
  }

  async upsert(input: UpsertConnectionInput): Promise<GitHubConnectionDocument> {
    this.upserted.push(input);
    const doc = makeConnectionDoc({ githubUsername: input.githubUsername });
    this.connections.set(input.userId, doc);
    return doc;
  }

  async findByUserId(userId: string): Promise<GitHubConnectionDocument | null> {
    return this.connections.get(userId) ?? null;
  }

  async deleteByUserId(userId: string): Promise<void> {
    this.deletedUserIds.push(userId);
    this.connections.delete(userId);
  }
}

class FakeGitHubOAuthStateRepository implements IGitHubOAuthStateRepository {
  public created: Array<{ state: string; userId: string; expiresAt: Date }> = [];
  private states = new Map<string, { userId: string }>();

  async create(state: string, userId: string, expiresAt: Date): Promise<GitHubOAuthStateDocument> {
    this.created.push({ state, userId, expiresAt });
    this.states.set(state, { userId });
    return { state, userId: { toString: () => userId } } as unknown as GitHubOAuthStateDocument;
  }

  async consumeByState(state: string): Promise<GitHubOAuthStateDocument | null> {
    const found = this.states.get(state);
    if (!found) return null;
    this.states.delete(state); // single-use, matching the real atomic behavior
    return { state, userId: { toString: () => found.userId } } as unknown as GitHubOAuthStateDocument;
  }
}

class FakeTokenEncryptor implements ITokenEncryptor {
  public lastEncrypted: string | null = null;

  encrypt(plaintext: string): EncryptedValue {
    this.lastEncrypted = plaintext;
    return { ciphertext: `encrypted(${plaintext})`, iv: 'fake-iv', authTag: 'fake-tag', keyVersion: 1 };
  }

  decrypt(value: EncryptedValue): string {
    // Mirrors encrypt()'s format above, for round-trip fakes in tests.
    const match = /^encrypted\((.*)\)$/.exec(value.ciphertext);
    return match ? match[1]! : 'decrypted-fallback-token';
  }
}

describe('GitHubOAuthService - initiateConnect', () => {
  it('creates a state record tied to the given userId and returns the authorize URL', async () => {
    const stateRepo = new FakeGitHubOAuthStateRepository();
    const service = new GitHubOAuthService(
      new FakeGitHubOAuthClient({ accessToken: 'x', scopes: [] }),
      new FakeGitHubConnectionRepository(),
      stateRepo,
      new FakeTokenEncryptor(),
    );

    const authorizeUrl = await service.initiateConnect('user-1');

    expect(stateRepo.created).toHaveLength(1);
    expect(stateRepo.created[0]!.userId).toBe('user-1');
    expect(authorizeUrl).toContain('github.com/login/oauth/authorize');
    expect(authorizeUrl).toContain(stateRepo.created[0]!.state);
  });

  it('sets the state to expire roughly 10 minutes from now', async () => {
    const stateRepo = new FakeGitHubOAuthStateRepository();
    const service = new GitHubOAuthService(
      new FakeGitHubOAuthClient({ accessToken: 'x', scopes: [] }),
      new FakeGitHubConnectionRepository(),
      stateRepo,
      new FakeTokenEncryptor(),
    );

    const before = Date.now();
    await service.initiateConnect('user-1');
    const expiresAt = stateRepo.created[0]!.expiresAt.getTime();

    expect(expiresAt).toBeGreaterThan(before + 9 * 60 * 1000);
    expect(expiresAt).toBeLessThan(before + 11 * 60 * 1000);
  });
});

describe('GitHubOAuthService - handleCallback', () => {
  it('rejects an unknown or already-consumed state', async () => {
    const service = new GitHubOAuthService(
      new FakeGitHubOAuthClient({ accessToken: 'x', scopes: [] }),
      new FakeGitHubConnectionRepository(),
      new FakeGitHubOAuthStateRepository(), // empty - no state was ever created
      new FakeTokenEncryptor(),
    );

    await expect(service.handleCallback('some-code', 'unknown-state')).rejects.toThrow(UnauthorizedError);
  });

  it('on success, encrypts the token and stores the connection under the userId recovered from the state', async () => {
    const stateRepo = new FakeGitHubOAuthStateRepository();
    const connectionRepo = new FakeGitHubConnectionRepository();
    const encryptor = new FakeTokenEncryptor();
    const oauthClient = new FakeGitHubOAuthClient(
      { accessToken: 'gho_realtoken', scopes: ['repo'] },
      { githubUserId: 42, githubUsername: 'octocat' },
    );
    const service = new GitHubOAuthService(oauthClient, connectionRepo, stateRepo, encryptor);

    await stateRepo.create('state-abc', 'user-42', new Date(Date.now() + 60_000));
    const result = await service.handleCallback('code-xyz', 'state-abc');

    expect(result.userId).toBe('user-42');
    expect(result.githubUsername).toBe('octocat');
    expect(encryptor.lastEncrypted).toBe('gho_realtoken'); // the RAW token was encrypted, not left plaintext
    expect(connectionRepo.upserted).toHaveLength(1);
    expect(connectionRepo.upserted[0]!.userId).toBe('user-42');
    expect(connectionRepo.upserted[0]!.githubUserId).toBe(42);
    expect(connectionRepo.upserted[0]!.scopes).toEqual(['repo']);
  });

  it('does not store a connection if the token exchange fails entirely', async () => {
    const stateRepo = new FakeGitHubOAuthStateRepository();
    const connectionRepo = new FakeGitHubConnectionRepository();
    const service = new GitHubOAuthService(
      new FakeGitHubOAuthClient('always-fail'),
      connectionRepo,
      stateRepo,
      new FakeTokenEncryptor(),
    );

    await stateRepo.create('state-fail', 'user-1', new Date(Date.now() + 60_000));

    await expect(service.handleCallback('code', 'state-fail')).rejects.toThrow();
    expect(connectionRepo.upserted).toHaveLength(0);
  });

  it('retries the token exchange once on a transient failure, and succeeds on the second attempt', async () => {
    const stateRepo = new FakeGitHubOAuthStateRepository();
    const connectionRepo = new FakeGitHubConnectionRepository();
    const oauthClient = new FakeGitHubOAuthClient('fail-once-then-succeed');
    const service = new GitHubOAuthService(oauthClient, connectionRepo, stateRepo, new FakeTokenEncryptor());

    await stateRepo.create('state-retry', 'user-1', new Date(Date.now() + 60_000));
    await service.handleCallback('code', 'state-retry');

    expect(oauthClient.exchangeAttempts).toBe(2);
    expect(connectionRepo.upserted).toHaveLength(1);
  });
});

describe('GitHubOAuthService - disconnect', () => {
  it('throws NotFoundError if no connection exists for the user', async () => {
    const service = new GitHubOAuthService(
      new FakeGitHubOAuthClient({ accessToken: 'x', scopes: [] }),
      new FakeGitHubConnectionRepository(),
      new FakeGitHubOAuthStateRepository(),
      new FakeTokenEncryptor(),
    );

    await expect(service.disconnect('user-with-no-connection')).rejects.toThrow(NotFoundError);
  });

  it('decrypts the stored token, attempts remote revocation, and deletes the local connection', async () => {
    const connectionRepo = new FakeGitHubConnectionRepository();
    const encryptor = new FakeTokenEncryptor();
    const oauthClient = new FakeGitHubOAuthClient({ accessToken: 'x', scopes: [] });
    const service = new GitHubOAuthService(oauthClient, connectionRepo, new FakeGitHubOAuthStateRepository(), encryptor);

    connectionRepo.seed(
      'user-1',
      makeConnectionDoc({ encryptedToken: 'encrypted(gho_realtoken)', iv: 'iv', authTag: 'tag', keyVersion: 1 }),
    );

    await service.disconnect('user-1');

    expect(oauthClient.revokeCalledWith).toBe('gho_realtoken'); // the decrypted plaintext, not ciphertext
    expect(connectionRepo.deletedUserIds).toEqual(['user-1']);
  });

  it("still deletes the local connection even if remote revocation fails - the user's own intent to disconnect is not blocked by GitHub API availability", async () => {
    const connectionRepo = new FakeGitHubConnectionRepository();
    const oauthClient = new FakeGitHubOAuthClient({ accessToken: 'x', scopes: [] }, undefined, true); // revokeShouldFail
    const service = new GitHubOAuthService(
      oauthClient,
      connectionRepo,
      new FakeGitHubOAuthStateRepository(),
      new FakeTokenEncryptor(),
    );

    connectionRepo.seed('user-1', makeConnectionDoc({ encryptedToken: 'encrypted(gho_token)' }));

    await expect(service.disconnect('user-1')).resolves.not.toThrow();
    expect(connectionRepo.deletedUserIds).toEqual(['user-1']);
  });
});
