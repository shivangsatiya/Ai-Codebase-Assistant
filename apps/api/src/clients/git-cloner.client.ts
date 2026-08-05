import { simpleGit } from 'simple-git';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from '../utils/logger';

export interface ClonedRepo {
  localPath: string;
  commitSha: string;
  cleanup: () => Promise<void>;
}

/**
 * Same reasoning as IGitHubClient - lets RepositoryImportService be
 * tested against a fake that never shells out to a real git binary or
 * touches the real filesystem.
 */
export interface IGitClonerClient {
  clone(cloneUrl: string, branch: string, userToken?: string): Promise<ClonedRepo>;
}

/**
 * Why clone into a fresh os.tmpdir() subdirectory per job, and always
 * shallow (--depth 1, single branch)?
 *
 * Isolation: two concurrent imports must never share a working directory.
 * Speed + safety: a shallow, single-branch clone avoids pulling a repo's
 * entire history (irrelevant to parsing current source) and bounds how
 * much disk/time one import can consume. `cleanup()` is called in a
 * `finally` block by the caller so a crash mid-parse doesn't leave
 * cloned source code sitting on disk indefinitely.
 */
export class GitClonerClient implements IGitClonerClient {
  /**
   * Why does `git.clone()` receive a separately-built authenticated URL
   * while every log line and every thrown error below still only ever
   * references the plain `cloneUrl` parameter?
   *
   * This is the exact credential-leak the design review flagged before
   * this task existed: `cloneUrl` used to be safe to log unconditionally
   * because it never carried a secret. The moment a private repo's clone
   * needs `https://x-access-token:TOKEN@github.com/...` embedded in the
   * URL actually used for the clone, that safety assumption breaks.
   * Verified via `simple-git`'s own source during the Milestone 2 design
   * review that it calls `child_process.spawn()` with a separate argv
   * array, not a shell string - so this embedded credential is never at
   * risk of shell injection.
   *
   * Why does the catch block below throw a brand NEW Error instead of
   * re-throwing the original one from simple-git?
   *
   * A real bug, caught by actually running a test against a real
   * failing clone rather than assuming the fix above was sufficient:
   * simple-git's own GitError object embeds the FULL command line -
   * including the authenticated URL - in a `task.commands` property.
   * Only avoiding passing the authenticated URL to `logger` directly
   * wasn't enough, because `logger.error({ err, cloneUrl })` serializes
   * the ENTIRE err object, task.commands included. Worse, this error
   * propagates up to RepositoryImportService.failImport(), which logs
   * it AGAIN with no way to know this specific error type carries
   * sensitive data - fixing only the one call site here would have left
   * that second leak untouched. Extracting a sanitized message and
   * throwing a clean Error means the sensitive raw error object simply
   * never exists beyond this one catch block, so no code downstream -
   * however carelessly it might log an error - can leak it.
   */
  async clone(cloneUrl: string, branch: string, userToken?: string): Promise<ClonedRepo> {
    const localPath = await mkdtemp(join(tmpdir(), 'aca-clone-'));
    const authenticatedCloneUrl = userToken ? this.embedToken(cloneUrl, userToken) : cloneUrl;

    try {
      const git = simpleGit();
      await git.clone(authenticatedCloneUrl, localPath, [
        '--depth',
        '1',
        '--single-branch',
        '--branch',
        branch,
      ]);

      // Resolved AFTER cloning, not read from the GitHub API's default
      // branch info beforehand - a shallow clone's HEAD is the actual
      // commit we chunked and embedded, which is what the
      // (repositoryId, commitSha, contentHash) idempotency key needs to
      // be accurate for.
      const commitSha = (await simpleGit(localPath).revparse(['HEAD'])).trim();

      return {
        localPath,
        commitSha,
        cleanup: async () => {
          await rm(localPath, { recursive: true, force: true });
        },
      };
    } catch (err) {
      // Clean up the (likely partial/empty) temp dir before re-throwing —
      // otherwise a failed clone leaks a directory every time.
      await rm(localPath, { recursive: true, force: true }).catch(() => undefined);

      const sanitizedMessage = this.sanitizeErrorMessage(err);
      logger.error({ cloneUrl, message: sanitizedMessage }, 'Git clone failed');
      throw new Error(`Git clone failed: ${sanitizedMessage}`);
    }
  }

  private embedToken(cloneUrl: string, token: string): string {
    return cloneUrl.replace('https://', `https://x-access-token:${token}@`);
  }

  /**
   * Extracts only the message string from whatever simple-git threw
   * (discarding every other property, including task.commands - the
   * actual source of the leak found above), then defensively strips any
   * basic-auth-style credential from that string too, in case a
   * different git failure mode or a different simple-git version ever
   * echoes an authenticated URL directly into its message rather than a
   * separate metadata field the way this specific error type did.
   */
  private sanitizeErrorMessage(err: unknown): string {
    const rawMessage = err instanceof Error ? err.message : String(err);
    return rawMessage.replace(/https:\/\/[^:/@\s]+:[^@\s]+@/g, 'https://[REDACTED]@');
  }
}
