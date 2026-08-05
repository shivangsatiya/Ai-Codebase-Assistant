import mongoose from 'mongoose';
import { MongoGitHubOAuthStateRepository } from '../src/repositories/github-oauth-state.repository';

describe('MongoGitHubOAuthStateRepository', () => {
  function futureDate(minutesFromNow = 10): Date {
    return new Date(Date.now() + minutesFromNow * 60 * 1000);
  }

  it('create() then consumeByState() returns the record with the correct userId', async () => {
    const repo = new MongoGitHubOAuthStateRepository();
    const userId = new mongoose.Types.ObjectId().toString();

    await repo.create('test-state-1', userId, futureDate());
    const consumed = await repo.consumeByState('test-state-1');

    expect(consumed).not.toBeNull();
    expect(consumed!.userId.toString()).toBe(userId);
  });

  it('consumeByState() returns null for a state that was never created', async () => {
    const repo = new MongoGitHubOAuthStateRepository();

    const consumed = await repo.consumeByState('never-created-state');

    expect(consumed).toBeNull();
  });

  it('a state can only be consumed once - the second call returns null', async () => {
    const repo = new MongoGitHubOAuthStateRepository();
    const userId = new mongoose.Types.ObjectId().toString();

    await repo.create('single-use-state', userId, futureDate());

    const first = await repo.consumeByState('single-use-state');
    const second = await repo.consumeByState('single-use-state');

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('regression test for the design review fix: under concurrent consumption of the SAME state, only one caller succeeds', async () => {
    // This is the direct test for the concurrency bug the design review
    // found: written as a separate find-then-delete, two concurrent
    // requests carrying the same state could both pass the lookup
    // before either completed the delete. A single atomic
    // findOneAndDelete makes this genuinely impossible - MongoDB itself
    // guarantees only one of two simultaneous findOneAndDelete calls
    // against the same document can find (and therefore delete) it.
    const repo = new MongoGitHubOAuthStateRepository();
    const userId = new mongoose.Types.ObjectId().toString();

    await repo.create('concurrent-state', userId, futureDate());

    const [resultA, resultB] = await Promise.all([
      repo.consumeByState('concurrent-state'),
      repo.consumeByState('concurrent-state'),
    ]);

    const successCount = [resultA, resultB].filter((r) => r !== null).length;
    expect(successCount).toBe(1);
  });

  it('two different states for the same user are independent - consuming one does not affect the other', async () => {
    const repo = new MongoGitHubOAuthStateRepository();
    const userId = new mongoose.Types.ObjectId().toString();

    await repo.create('state-x', userId, futureDate());
    await repo.create('state-y', userId, futureDate());

    await repo.consumeByState('state-x');

    const stateY = await repo.consumeByState('state-y');
    expect(stateY).not.toBeNull();
  });
});
