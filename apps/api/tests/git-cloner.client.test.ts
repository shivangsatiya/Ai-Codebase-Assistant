import { GitClonerClient } from '../src/clients/git-cloner.client';
import { logger } from '../src/utils/logger';

describe('GitClonerClient - token safety (Milestone 2, Task 4)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * This is the direct regression test for the exact credential-leak the
   * design review flagged before this task existed: `cloneUrl` used to
   * be safe to log unconditionally, until a private repo's clone needed
   * a token embedded in the URL actually passed to `git clone`. A real
   * (deliberately failing - nonexistent repo) clone attempt with a fake
   * token proves the log line never contains it, using an actual
   * network call rather than mocking simple-git's internals, which
   * would only prove the test's own assumptions about how simple-git
   * behaves, not the real thing.
   */
  it('never logs the embedded token, even when a clone with a userToken fails', async () => {
    const errorSpy = jest.spyOn(logger, 'error');
    const client = new GitClonerClient();
    const secretToken = 'gho_thisTokenMustNeverAppearInLogs123456';

    await expect(
      client.clone(
        'https://github.com/definitely-nonexistent-owner-aca-test/definitely-nonexistent-repo-aca-test.git',
        'main',
        secretToken,
      ),
    ).rejects.toThrow();

    expect(errorSpy).toHaveBeenCalled();
    const loggedPayload = JSON.stringify(errorSpy.mock.calls[0]);
    expect(loggedPayload).not.toContain(secretToken);
  }, 30000);

  it('the logged cloneUrl is still the original, credential-free URL - not omitted entirely, just never carrying the token', async () => {
    const errorSpy = jest.spyOn(logger, 'error');
    const client = new GitClonerClient();
    const originalUrl = 'https://github.com/definitely-nonexistent-owner-aca-test/definitely-nonexistent-repo-aca-test.git';

    await expect(client.clone(originalUrl, 'main', 'gho_sometoken')).rejects.toThrow();

    const loggedPayload = JSON.stringify(errorSpy.mock.calls[0]);
    expect(loggedPayload).toContain(originalUrl);
  }, 30000);

  it('a clone with no userToken behaves identically to before this task - no token, nothing to embed', async () => {
    const errorSpy = jest.spyOn(logger, 'error');
    const client = new GitClonerClient();
    const originalUrl = 'https://github.com/definitely-nonexistent-owner-aca-test/definitely-nonexistent-repo-aca-test.git';

    await expect(client.clone(originalUrl, 'main')).rejects.toThrow();

    const loggedPayload = JSON.stringify(errorSpy.mock.calls[0]);
    expect(loggedPayload).toContain(originalUrl);
  }, 30000);
});
