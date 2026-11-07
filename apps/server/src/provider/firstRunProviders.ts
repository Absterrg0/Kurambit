import {
  defaultInstanceIdForDriver,
  resolveProviderInstanceEnabled,
  type ProviderDriverKind,
  type ProviderInstanceConfigMap,
  type ProviderInstanceId,
} from "@kurambit/contracts";
import { isCommandAvailable } from "@kurambit/shared/shell";
import * as Effect from "effect/Effect";

import * as Settings from "../serverSettings.ts";
import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";

/**
 * PURE. The default-off agents a fresh home turns on: each one whose CLI is
 * installed and that has no instance of its own yet. Only a home that had no
 * settings file qualifies, so a later launch never revives an agent the person
 * turned off, and an existing home is never changed under them.
 */
export const firstRunProviderInstances = (input: {
  readonly startedWithoutSettingsFile: boolean;
  readonly configured: ProviderInstanceConfigMap;
  readonly candidates: ReadonlyArray<{
    readonly driver: ProviderDriverKind;
    readonly installed: boolean;
  }>;
}): ReadonlyArray<{
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
}> =>
  input.startedWithoutSettingsFile
    ? input.candidates.flatMap(({ driver, installed }) => {
        const instanceId = defaultInstanceIdForDriver(driver);
        return installed && !Object.hasOwn(input.configured, instanceId)
          ? [{ instanceId, driver }]
          : [];
      })
    : [];

/**
 * Codex and Claude are probed by default; the other built-in agents that run
 * a CLI from PATH (OpenCode, Grok, Pi, Muse) are off until added. On a fresh
 * home this turns on the ones already installed, found on PATH as their status
 * check would run them, so onboarding lists them with their real status.
 */
export const enableInstalledProvidersOnFirstRun = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  if (settings.startedWithoutSettingsFile !== true) return;
  const current = yield* settings.getSettings;
  const candidates: Array<{ driver: ProviderDriverKind; installed: boolean }> = [];
  for (const driver of BUILT_IN_DRIVERS) {
    if (driver.metadata.hasDefaultInstance === false) continue;
    if (resolveProviderInstanceEnabled({ driver: driver.driverKind })) continue;
    const config: unknown = driver.defaultConfig();
    const binary =
      typeof config === "object" &&
      config !== null &&
      "binaryPath" in config &&
      typeof config.binaryPath === "string"
        ? config.binaryPath.trim()
        : "";
    // Agents without a PATH CLI (Cursor's SDK, Antigravity's managed install) stay opt-in.
    if (binary === "") continue;
    candidates.push({ driver: driver.driverKind, installed: yield* isCommandAvailable(binary) });
  }
  for (const { instanceId, driver } of firstRunProviderInstances({
    startedWithoutSettingsFile: true,
    configured: current.providerInstances,
    candidates,
  })) {
    yield* settings.updateProviderInstance({
      operation: "upsert",
      instanceId,
      instance: { driver, enabled: true },
    });
    yield* Effect.logInfo("first run: enabled an installed agent", { instanceId });
  }
});
