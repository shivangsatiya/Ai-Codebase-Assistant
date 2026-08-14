import type { FailureCategory } from '../models/job.model';

/**
 * Classifies an import-pipeline failure as retryable or permanent.
 *
 * Deliberately conservative: only a small set of KNOWN-permanent
 * patterns are matched explicitly (real, sanitized messages this
 * project's own git-cloner.client.ts is confirmed to produce - "Repository
 * not found", "Invalid username or token", "Authentication failed").
 * Everything else defaults to retryable.
 *
 * Why default to retryable rather than the reverse?
 *
 * The two possible mistakes are not equally bad. A false "retryable"
 * costs at most a couple of extra attempts (bounded by maxAttempts,
 * default 3) before correctly landing on FAILED anyway. A false
 * "permanent" would give up immediately on a job that could genuinely
 * have succeeded on retry - the worse failure mode, and the opposite
 * of what this whole task exists to prevent. Confirmed directly: this
 * codebase does not throw typed AppError subclasses for clone or
 * embedding failures (git-cloner.client.ts deliberately throws a
 * plain, sanitized Error - see its own comment on why), so there is no
 * richer signal available here than the message text itself.
 */
export function classifyImportFailure(err: unknown): FailureCategory {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  const permanentPatterns = [
    'repository not found',
    'invalid username or token',
    'authentication failed',
    'not found',
    'permission denied',
  ];

  if (permanentPatterns.some((pattern) => lower.includes(pattern))) {
    return 'permanent';
  }

  return 'retryable';
}
