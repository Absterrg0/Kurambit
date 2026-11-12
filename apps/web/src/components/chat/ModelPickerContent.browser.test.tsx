import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceId as ProviderInstanceIdType,
  type ServerProvider,
} from "@kurambit/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ModelPickerContent } from "./ModelPickerContent";
import type { ModelEsque } from "./providerIconUtils";

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => async () => {}) as never,
}));

function provider(instanceId: string, driver: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-28T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function renderPicker() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const entries = deriveProviderInstanceEntries([
    provider("codex_work", "codex"),
    provider("claude_work", "claudeAgent"),
  ]);
  const codex = entries[0]!;
  const claude = entries[1]!;
  const options = new Map<ProviderInstanceIdType, ReadonlyArray<ModelEsque>>([
    [codex.instanceId, [{ slug: "gpt-a", name: "GPT A" }]],
    [
      claude.instanceId,
      [
        { slug: "claude-a", name: "Claude A" },
        { slug: "claude-old", name: "Claude Old", isLegacy: true },
      ],
    ],
  ]);
  const picked = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <ModelPickerContent
        environmentId={null}
        activeInstanceId={codex.instanceId}
        model="gpt-a"
        lockedProvider={null}
        instanceEntries={entries}
        keybindings={[]}
        modelOptionsByInstance={options}
        terminalOpen={false}
        onInstanceModelChange={picked}
      />,
    ),
  );
  return { container, codex, claude, picked };
}

describe("ModelPickerContent", () => {
  it("lists every provider under its own label, with legacy models on one row", async () => {
    const { container, codex, claude } = await renderPicker();
    const text = container.textContent ?? "";
    expect(text).toContain(codex.displayName);
    expect(text).toContain(claude.displayName);
    expect(text).toContain("GPT A");
    expect(text).toContain("Claude A");
    expect(text).toContain("Legacy models");
    expect(text).not.toContain("Claude Old");
  });

  it("picks the highlighted model with the keyboard", async () => {
    const { codex, picked } = await renderPicker();
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("{Enter}");
    expect(picked).toHaveBeenCalledWith(codex.instanceId, "gpt-a");
  });

  it("drops the group labels while searching", async () => {
    const { container, claude } = await renderPicker();
    await userEvent.keyboard("Claude A");
    const text = container.textContent ?? "";
    expect(text).toContain("Claude A");
    expect(text).not.toContain("GPT A");
    // The provider's name now trails the row instead of heading a group.
    expect(text).toContain(claude.displayName);
  });
});
