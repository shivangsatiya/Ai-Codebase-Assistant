import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMediaQuery, useIsMobileLayout } from '../use-media-query';

/**
 * A real, complete MediaQueryList mock - every property the real
 * lib.dom.d.ts interface requires, not just the ones a given test
 * happens to touch. A real, genuine gap was found in this file's
 * earlier draft: a partial mock cast through `as typeof
 * window.matchMedia` silently satisfied TypeScript at first glance
 * but was caught by a real `tsc --noEmit` run (Vitest's own runtime
 * uses transpile-only execution and does not itself catch this class
 * of error) - missing onchange/addListener/removeListener/
 * dispatchEvent. Centralized here once, correctly, rather than
 * repeated per-test.
 */
function mockMatchMedia(matchesFn: (query: string) => boolean, target: EventTarget = new EventTarget()) {
  const mock = ((query: string): MediaQueryList => ({
    matches: matchesFn(query),
    media: query,
    onchange: null,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    addListener: () => {},
    removeListener: () => {},
  })) as typeof window.matchMedia;
  globalThis.matchMedia = mock;
  return target;
}

describe('useMediaQuery', () => {
  const originalMatchMedia = globalThis.matchMedia;

  afterEach(() => {
    globalThis.matchMedia = originalMatchMedia;
  });

  it('reflects the real, current match state on mount, not a hardcoded default', () => {
    mockMatchMedia((query) => query === '(min-width: 768px)');

    const { result } = renderHook(() => useMediaQuery('(min-width: 768px)'));
    expect(result.current).toBe(true);

    const { result: result2 } = renderHook(() => useMediaQuery('(min-width: 2000px)'));
    expect(result2.current).toBe(false);
  });

  it(
    'REGRESSION: updates when the real browser reports a genuine viewport change - not just a snapshot ' +
      'taken once at mount and never revisited',
    () => {
      const target = mockMatchMedia(() => false);

      const { result } = renderHook(() => useMediaQuery('(min-width: 768px)'));
      expect(result.current).toBe(false);

      act(() => {
        target.dispatchEvent(Object.assign(new Event('change'), { matches: true }));
      });

      expect(result.current).toBe(true);
    },
  );
});

describe('useIsMobileLayout', () => {
  const originalMatchMedia = globalThis.matchMedia;

  afterEach(() => {
    globalThis.matchMedia = originalMatchMedia;
  });

  it(
    'REGRESSION: is the negation of the desktop min-width match, not the same direction - a viewport ' +
      'matching (min-width: 768px) means desktop, so isMobileLayout must be false there, not true',
    () => {
      mockMatchMedia((query) => query === '(min-width: 768px)');

      const { result } = renderHook(() => useIsMobileLayout());
      expect(result.current).toBe(false);
    },
  );

  it('is true when the real viewport does not match the desktop min-width', () => {
    mockMatchMedia(() => false);

    const { result } = renderHook(() => useIsMobileLayout());
    expect(result.current).toBe(true);
  });
});
