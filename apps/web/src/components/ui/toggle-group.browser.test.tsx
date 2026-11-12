import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Toggle, ToggleGroup } from "./toggle-group";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function indicator() {
  const element = container.querySelector<HTMLElement>("[data-slot=toggle-group-indicator]");
  if (!element) throw new Error("no indicator");
  return element;
}

function segment(name: string) {
  const element = Array.from(container.querySelectorAll<HTMLElement>("[data-slot=toggle]")).find(
    (candidate) => candidate.textContent === name,
  );
  if (!element) throw new Error(`no segment ${name}`);
  return element;
}

describe("segmented ToggleGroup", () => {
  it("keeps one pill under the pressed segment, wherever the press comes from", async () => {
    await act(async () =>
      root.render(
        <ToggleGroup aria-label="View" defaultValue={["build"]}>
          <Toggle value="build">Build</Toggle>
          <Toggle value="scene">A longer scene</Toggle>
        </ToggleGroup>,
      ),
    );
    expect(indicator().hidden).toBe(false);
    expect(indicator().style.getPropertyValue("--segment-x")).toBe(
      `${segment("Build").offsetLeft}px`,
    );
    // The pressed segment leaves its surface to the pill.
    expect(segment("Build").className).not.toContain("surface-raised");

    await act(async () => segment("A longer scene").click());
    // The MutationObserver delivers in a microtask after the attribute changes.
    await act(async () => Promise.resolve());
    expect(indicator().style.getPropertyValue("--segment-x")).toBe(
      `${segment("A longer scene").offsetLeft}px`,
    );
    expect(indicator().style.getPropertyValue("--segment-width")).toBe(
      `${segment("A longer scene").offsetWidth}px`,
    );
  });

  it("raises each pressed segment itself when several can be pressed", async () => {
    await act(async () =>
      root.render(
        <ToggleGroup aria-label="Filters" multiple defaultValue={["a", "b"]}>
          <Toggle value="a">A</Toggle>
          <Toggle value="b">B</Toggle>
        </ToggleGroup>,
      ),
    );
    expect(container.querySelector("[data-slot=toggle-group-indicator]")).toBeNull();
    expect(segment("A").className).toContain("surface-raised");
  });
});
