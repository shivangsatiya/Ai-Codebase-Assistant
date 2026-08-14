/**
 * Normalizes a GitHub URL for COMPARISON purposes only - never used to
 * change what's actually stored or displayed. Confirmed directly
 * (repository.schemas.ts) that the only existing validation is
 * `.trim()` plus URL-format checking - no case, trailing-slash, or
 * `.git`-suffix normalization exists anywhere today. Without this, a
 * duplicate-import check using an exact string match would miss real
 * duplicates like "github.com/foo/bar", "github.com/foo/bar/", and
 * "github.com/foo/bar.git" - three different strings, the same real
 * repository - defeating the actual stated goal ("do not silently
 * duplicate indexing work") for a plausible, ordinary case.
 */
export function normalizeGithubUrlForComparison(githubUrl: string): string {
  return githubUrl
    .trim()
    .toLowerCase()
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}
