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
  clone(cloneUrl: string, branch: string): Promise<ClonedRepo>;
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
  async clone(cloneUrl: string, branch: string): Promise<ClonedRepo> {
    const localPath = await mkdtemp(join(tmpdir(), 'aca-clone-'));

    try {
      const git = simpleGit();
      await git.clone(cloneUrl, localPath, [
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
      logger.error({ err, cloneUrl }, 'Git clone failed');
      throw err;
    }
  }
}
