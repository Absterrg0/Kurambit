import { AtomRegistry, AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { npmReleasePublishedAtom } from "./npmRelease";
it("never looks up an upstream npm release", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const registry = AtomRegistry.make();
  try {
    expect(AsyncResult.getOrElse(registry.get(npmReleasePublishedAtom("99.0.0")), () => true)).toBe(
      false,
    );
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    registry.dispose();
    vi.unstubAllGlobals();
  }
});
