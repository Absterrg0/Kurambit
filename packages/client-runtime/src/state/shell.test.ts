import type { ServerConfig } from "@kurambit/contracts";
import { EnvironmentId } from "@kurambit/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import { Atom, AtomRegistry } from "effect/reactivity";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import type { EnvironmentShellState } from "./shell.ts";
import {
  createEnvironmentServerConfigsAtom,
  createEnvironmentShellProgressAtoms,
} from "./shell.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const OTHER_ENVIRONMENT_ID = EnvironmentId.make("environment-2");

function environmentEntry(environmentId: EnvironmentId, label: string) {
  return {
    target: new PrimaryConnectionTarget({
      environmentId,
      label,
      httpBaseUrl: `https://${environmentId}.example.test`,
      wsBaseUrl: `wss://${environmentId}.example.test`,
    }),
    profile: Option.none(),
    enabled: true,
  };
}

function shellState(input: {
  readonly status: EnvironmentShellState["status"];
  readonly updatedAt?: string;
  readonly error?: string;
  readonly snapshotSequence?: number;
}): EnvironmentShellState {
  return {
    snapshot:
      input.updatedAt === undefined
        ? Option.none()
        : Option.some({
            schemaVersion: 1,
            snapshotSequence: input.snapshotSequence ?? 1,
            projects: [],
            threads: [
              {
                ...v2ThreadShell,
                updatedAt: DateTime.makeUnsafe(input.updatedAt),
              },
            ],
            archivedThreads: [],
          }),
    status: input.status,
    error: input.error === undefined ? Option.none() : Option.some(input.error),
  };
}

function makeHarness() {
  const shellStateAtoms = Atom.family((environmentId: EnvironmentId) =>
    Atom.make<EnvironmentShellState>(
      environmentId === ENVIRONMENT_ID
        ? shellState({
            status: "cached",
            updatedAt: "2026-06-01T00:00:00.000Z",
          })
        : shellState({
            status: "synchronizing",
            updatedAt: "2026-06-02T00:00:00.000Z",
            error: "Retrying.",
          }),
    ),
  );
  const configAtoms = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<ServerConfig | null>(null),
  );
  const catalogValueAtom = Atom.make({
    isReady: true,
    entries: new Map([
      [ENVIRONMENT_ID, environmentEntry(ENVIRONMENT_ID, "Environment")],
      [OTHER_ENVIRONMENT_ID, environmentEntry(OTHER_ENVIRONMENT_ID, "Other environment")],
    ]),
  });
  const serverConfigsAtom = createEnvironmentServerConfigsAtom({
    catalogValueAtom,
    serverConfigValueAtom: configAtoms,
  });

  return {
    catalogValueAtom,
    registry: AtomRegistry.make(),
    shellStateAtom: shellStateAtoms,
    configAtom: configAtoms,
    serverConfigsAtom,
  };
}

describe("environment shell projections", () => {
  it("preserves server-config map identity until a config reference changes", () => {
    const harness = makeHarness();
    const empty = harness.registry.get(harness.serverConfigsAtom);
    const config = { cwd: "/repo" } as ServerConfig;

    harness.registry.set(harness.configAtom(ENVIRONMENT_ID), config);
    const withConfig = harness.registry.get(harness.serverConfigsAtom);

    expect(withConfig).not.toBe(empty);
    expect(withConfig.get(ENVIRONMENT_ID)).toBe(config);

    harness.registry.set(harness.configAtom(ENVIRONMENT_ID), config);
    expect(harness.registry.get(harness.serverConfigsAtom)).toBe(withConfig);
  });

  it("keeps load progress quiet while threads stream and reports real progress", () => {
    const stateAtom = Atom.make(
      shellState({ status: "cached", updatedAt: "2026-06-01T00:00:00.000Z" }),
    );
    const registry = AtomRegistry.make();
    const { statusAtom, hasSnapshotAtom } = createEnvironmentShellProgressAtoms(() => stateAtom);
    let changes = 0;
    const unsubscribeStatus = registry.subscribe(statusAtom(ENVIRONMENT_ID), () => changes++);
    const unsubscribeSnapshot = registry.subscribe(
      hasSnapshotAtom(ENVIRONMENT_ID),
      () => changes++,
    );

    registry.set(
      stateAtom,
      shellState({ status: "cached", updatedAt: "2026-06-01T00:00:01.000Z" }),
    );
    expect(changes).toBe(0);

    registry.set(stateAtom, shellState({ status: "live", updatedAt: "2026-06-01T00:00:02.000Z" }));
    expect(registry.get(statusAtom(ENVIRONMENT_ID))).toBe("live");
    expect(changes).toBe(1);

    registry.set(stateAtom, shellState({ status: "live" }));
    expect(registry.get(hasSnapshotAtom(ENVIRONMENT_ID))).toBe(false);
    expect(changes).toBe(2);

    unsubscribeStatus();
    unsubscribeSnapshot();
  });
});
