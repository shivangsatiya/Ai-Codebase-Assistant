import '@testing-library/jest-dom/vitest';

/**
 * React Flow measures node/container dimensions via ResizeObserver
 * internally - JSDOM doesn't implement it at all, so without this,
 * every test rendering RepositoryGraph would fail with
 * "ResizeObserver is not defined" before ever reaching an assertion.
 * This is a minimal stub, not a real implementation - tests don't need
 * actual resize notifications, just for the constructor to exist.
 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver = ResizeObserverStub;

/**
 * JSDOM doesn't implement window.matchMedia at all either - same
 * category of gap as ResizeObserver above, same minimal-stub approach.
 * Defaults matches to true, deliberately: useIsMobileLayout() is
 * defined as the negation of a min-width match
 * (`!useMediaQuery('(min-width: 768px)')`), so a query matching by
 * default means "desktop", not "mobile" - every existing test in this
 * project was written before mobile support existed and implicitly
 * assumes desktop layout. A test that specifically wants to exercise
 * mobile-layout behavior calls window.matchMedia to get a real,
 * working addEventListener/removeEventListener pair, then dispatches a
 * real 'change' event through it with matches: false, rather than
 * needing yet another separate mock.
 */
globalThis.matchMedia = (query: string): MediaQueryList => {
  const target = new EventTarget();
  return {
    matches: true,
    media: query,
    onchange: null,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    // Deprecated, but still part of the real MediaQueryList interface
    // some code (including older React Flow internals, if ever
    // touched) might still call - implemented as real no-op aliases
    // rather than omitted, so a TypeScript structural check against
    // the real lib.dom.d.ts MediaQueryList type still passes.
    addListener: () => {},
    removeListener: () => {},
  } as MediaQueryList;
};
