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
