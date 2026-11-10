import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId } from "@kurambit/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  complete: vi.fn<() => Promise<void>>(),
  refresh: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => mocks.refresh,
}));
vi.mock("../../onboarding/firstRun", () => ({ useCompleteOnboarding: () => mocks.complete }));
vi.mock("../../state/environments", () => {
  const environment = {
    environmentId: "test-env",
    label: "Computer",
    connection: { phase: "connected" },
    entry: { enabled: true },
  };
  return {
    useEnvironments: () => ({ environments: [environment] }),
    usePrimaryEnvironment: () => environment,
  };
});
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providersValueAtom: () => [],
    configValueAtom: () => null,
    refreshProviders: "refresh",
  },
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAtomValue: (value: unknown) => value,
}));
vi.mock("../../state/terminal", () => ({ terminalEnvironment: {} }));
vi.mock("../ThreadTerminalDrawer", () => ({ TerminalViewport: () => null }));
vi.mock("../settings/ChatGptWelcomeCoordinator", () => ({ ChatGptWelcomeCoordinator: () => null }));
vi.mock("../settings/CodexSetupSection", () => ({
  CodexSetupSection: () => null,
  AddManagedCodexAccountDialog: () => null,
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: mocks.toast, close: vi.fn(), update: vi.fn() },
}));

import { WelcomeWizard } from "./WelcomeWizard";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  mocks.complete.mockResolvedValue(undefined);
  mocks.refresh.mockResolvedValue(undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function button(label: string) {
  const result = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(result, `button ${label}`).toBeDefined();
  return result!;
}

async function click(label: string) {
  await act(async () => button(label).click());
}

it("finishes from Agents after Connect, without offering coding-project imports", async () => {
  const onDone = vi.fn();
  await act(async () => root.render(<WelcomeWizard onDone={onDone} />));
  expect(document.body.textContent).toContain("Create games on this computer");
  expect(document.body.textContent).not.toContain("Projects");
  await click("Continue");
  expect(document.body.textContent).toContain("Sign in to the agents that build your games");
  await click("Start making games");
  expect(mocks.complete).toHaveBeenCalledOnce();
  expect(onDone).toHaveBeenCalledExactlyOnceWith();
  expect(mocks.complete.mock.invocationCallOrder[0]).toBeLessThan(
    onDone.mock.invocationCallOrder[0]!,
  );
  expect(mocks.toast).not.toHaveBeenCalled();
});

it("resumes agent setup and finishes directly", async () => {
  const onDone = vi.fn();
  await act(async () =>
    root.render(
      <WelcomeWizard resumeEnvironmentId={EnvironmentId.make("test-env")} onDone={onDone} />,
    ),
  );
  expect(document.body.textContent).toContain("Connect your agents");
  await click("Start making games");
  expect(onDone).toHaveBeenCalledOnce();
});

it("keeps Agents open when saving completion fails and allows retry", async () => {
  mocks.complete.mockRejectedValueOnce(new Error("settings unavailable"));
  const onDone = vi.fn();
  await act(async () => root.render(<WelcomeWizard onDone={onDone} />));
  await click("Continue");
  await click("Start making games");
  expect(onDone).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({ type: "error", title: "Could not finish setup" }),
  );
  await click("Start making games");
  expect(mocks.complete).toHaveBeenCalledTimes(2);
  expect(onDone).toHaveBeenCalledOnce();
});

it("saves completion once and waits for it before leaving setup", async () => {
  let resolveCompletion = () => {};
  mocks.complete.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    }),
  );
  const onDone = vi.fn();
  await act(async () => root.render(<WelcomeWizard onDone={onDone} />));
  await click("Continue");
  const finish = button("Start making games");
  await act(async () => {
    finish.click();
    finish.click();
  });
  expect(mocks.complete).toHaveBeenCalledOnce();
  expect(onDone).not.toHaveBeenCalled();
  expect(button("Finishing setup…").disabled).toBe(true);
  await act(async () => resolveCompletion());
  expect(onDone).toHaveBeenCalledOnce();
});
