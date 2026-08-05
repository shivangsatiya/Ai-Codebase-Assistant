import mongoose from 'mongoose';
import { MongoGitHubConnectionRepository } from '../src/repositories/github-connection.repository';
import type { EncryptedValue } from '../src/utils/token-encryptor';

function makeEncryptedValue(overrides: Partial<EncryptedValue> = {}): EncryptedValue {
  return {
    ciphertext: 'fake-ciphertext',
    iv: 'fake-iv',
    authTag: 'fake-auth-tag',
    keyVersion: 1,
    ...overrides,
  };
}

describe('MongoGitHubConnectionRepository', () => {
  it('upsert() creates a new connection when none exists for the user', async () => {
    const repo = new MongoGitHubConnectionRepository();
    const userId = new mongoose.Types.ObjectId().toString();

    const created = await repo.upsert({
      userId,
      githubUserId: 12345,
      githubUsername: 'octocat',
      encryptedToken: makeEncryptedValue(),
      scopes: ['repo'],
    });

    expect(created.githubUsername).toBe('octocat');
    expect(created.userId.toString()).toBe(userId);
  });

  it('upsert() updates the existing connection on a second call for the same user, rather than throwing a duplicate-key error', async () => {
    // This is the specific regression test for the design review's fix:
    // the original design only specified a unique index on userId
    // without specifying insert-vs-upsert behavior for a reconnection,
    // which would have hit a duplicate-key error on the second call.
    const repo = new MongoGitHubConnectionRepository();
    const userId = new mongoose.Types.ObjectId().toString();

    await repo.upsert({
      userId,
      githubUserId: 12345,
      githubUsername: 'octocat',
      encryptedToken: makeEncryptedValue({ ciphertext: 'first-token' }),
      scopes: ['repo'],
    });

    // Reconnecting - possibly with a different scope grant, definitely
    // a different encrypted token value.
    const reconnected = await repo.upsert({
      userId,
      githubUserId: 12345,
      githubUsername: 'octocat',
      encryptedToken: makeEncryptedValue({ ciphertext: 'second-token' }),
      scopes: ['repo', 'read:user'],
    });

    expect(reconnected.encryptedToken).toBe('second-token');
    expect(reconnected.scopes).toEqual(['repo', 'read:user']);

    // Confirms it was genuinely an update, not an accidental second
    // document for the same user.
    const found = await repo.findByUserId(userId);
    expect(found?.encryptedToken).toBe('second-token');
  });

  it('findByUserId() returns null when no connection exists', async () => {
    const repo = new MongoGitHubConnectionRepository();

    const found = await repo.findByUserId(new mongoose.Types.ObjectId().toString());

    expect(found).toBeNull();
  });

  it('deleteByUserId() removes the connection', async () => {
    const repo = new MongoGitHubConnectionRepository();
    const userId = new mongoose.Types.ObjectId().toString();

    await repo.upsert({
      userId,
      githubUserId: 12345,
      githubUsername: 'octocat',
      encryptedToken: makeEncryptedValue(),
      scopes: ['repo'],
    });

    await repo.deleteByUserId(userId);

    expect(await repo.findByUserId(userId)).toBeNull();
  });

  it('two different users have fully independent connections', async () => {
    const repo = new MongoGitHubConnectionRepository();
    const userA = new mongoose.Types.ObjectId().toString();
    const userB = new mongoose.Types.ObjectId().toString();

    await repo.upsert({
      userId: userA,
      githubUserId: 111,
      githubUsername: 'user-a',
      encryptedToken: makeEncryptedValue(),
      scopes: ['repo'],
    });
    await repo.upsert({
      userId: userB,
      githubUserId: 222,
      githubUsername: 'user-b',
      encryptedToken: makeEncryptedValue(),
      scopes: ['repo'],
    });

    expect((await repo.findByUserId(userA))?.githubUsername).toBe('user-a');
    expect((await repo.findByUserId(userB))?.githubUsername).toBe('user-b');
  });
});
