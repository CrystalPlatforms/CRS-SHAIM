import "@testing-library/jest-dom/vitest";

// jsdom has no IntersectionObserver; the ShinyText label (issue #24) uses
// one to pause its shine off-screen. A no-op stub keeps the effect inert.
class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
if (typeof globalThis.IntersectionObserver === "undefined") {
  (globalThis as Record<string, unknown>).IntersectionObserver =
    IntersectionObserverStub;
}
