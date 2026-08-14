import { normalizeGithubUrlForComparison } from '../src/utils/github-url-normalizer';

describe('normalizeGithubUrlForComparison', () => {
  it('treats a trailing slash as the same URL', () => {
    expect(normalizeGithubUrlForComparison('https://github.com/foo/bar')).toBe(
      normalizeGithubUrlForComparison('https://github.com/foo/bar/'),
    );
  });

  it('treats a .git suffix as the same URL', () => {
    expect(normalizeGithubUrlForComparison('https://github.com/foo/bar')).toBe(
      normalizeGithubUrlForComparison('https://github.com/foo/bar.git'),
    );
  });

  it('treats different casing as the same URL', () => {
    expect(normalizeGithubUrlForComparison('https://github.com/Foo/Bar')).toBe(
      normalizeGithubUrlForComparison('https://github.com/foo/bar'),
    );
  });

  it('treats surrounding whitespace as the same URL', () => {
    expect(normalizeGithubUrlForComparison('  https://github.com/foo/bar  ')).toBe(
      normalizeGithubUrlForComparison('https://github.com/foo/bar'),
    );
  });

  it('a genuinely different repository is NOT normalized to the same value', () => {
    expect(normalizeGithubUrlForComparison('https://github.com/foo/bar')).not.toBe(
      normalizeGithubUrlForComparison('https://github.com/foo/baz'),
    );
  });

  it('a genuinely different owner is NOT normalized to the same value', () => {
    expect(normalizeGithubUrlForComparison('https://github.com/foo/bar')).not.toBe(
      normalizeGithubUrlForComparison('https://github.com/other/bar'),
    );
  });

  it('all real variations of the same URL normalize to one identical value', () => {
    const variants = [
      'https://github.com/foo/bar',
      'https://github.com/foo/bar/',
      'https://github.com/foo/bar.git',
      'https://github.com/Foo/Bar.git',
      '  https://github.com/FOO/BAR/  ',
    ];
    const normalized = new Set(variants.map(normalizeGithubUrlForComparison));
    expect(normalized.size).toBe(1);
  });
});
