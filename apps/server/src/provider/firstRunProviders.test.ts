import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@kurambit/contracts";
import { firstRunProviderInstances } from "./firstRunProviders.ts";

const opencode = ProviderDriverKind.make("opencode");
const grok = ProviderDriverKind.make("grok");

describe("firstRunProviderInstances", () => {
  it("a fresh home turns on the installed agents only", () => {
    expect(
      firstRunProviderInstances({
        startedWithoutSettingsFile: true,
        configured: {},
        candidates: [
          { driver: opencode, installed: true },
          { driver: grok, installed: false },
        ],
      }),
    ).toEqual([{ instanceId: ProviderInstanceId.make("opencode"), driver: opencode }]);
  });

  it("a home that already had settings is never changed, so a turned-off agent stays off", () => {
    expect(
      firstRunProviderInstances({
        startedWithoutSettingsFile: false,
        configured: {},
        candidates: [{ driver: opencode, installed: true }],
      }),
    ).toEqual([]);
  });

  it("an agent the settings already name keeps what they say", () => {
    expect(
      firstRunProviderInstances({
        startedWithoutSettingsFile: true,
        configured: { [ProviderInstanceId.make("opencode")]: { driver: opencode, enabled: false } },
        candidates: [{ driver: opencode, installed: true }],
      }),
    ).toEqual([]);
  });
});
