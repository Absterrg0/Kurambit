import { it, expect } from "@effect/vitest";
import { planWindowsPreset } from "./windowsPreset.ts";

const webAndLinux = `[preset.0]
name="Web"
platform="Web"
export_path="../builds/web/index.html"

[preset.0.options]
variant/thread_support=false

[preset.1]
name="Linux"
platform="Linux"
export_path="../builds/linux/game.x86_64"

[preset.1.options]
binary_format/embed_pck=true
binary_format/architecture="x86_64"
`;

it("adds a Windows preset without touching the presets the creator already has", () => {
  const plan = planWindowsPreset(webAndLinux);
  expect(plan.ok).toBe(true);
  if (!plan.ok) return;
  expect(plan.name).toBe("Windows");
  expect(plan.embeddedPck).toBe(true);
  expect(plan.text).not.toBeNull();
  expect(plan.text!.startsWith(webAndLinux)).toBe(true);
  expect(plan.text).toContain("[preset.2]");
  expect(plan.text).toContain('platform="Windows Desktop"');
  expect(plan.text).toContain('export_path="../builds/windows/game.exe"');
  expect(plan.text).toContain("binary_format/embed_pck=true");
  expect(plan.text).toContain('binary_format/architecture="x86_64"');
});

it("is unchanged on a second read, so exporting twice rewrites nothing", () => {
  const first = planWindowsPreset(webAndLinux);
  expect(first.ok).toBe(true);
  if (!first.ok || first.text === null) return;
  const second = planWindowsPreset(first.text);
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  expect(second.text).toBeNull();
  expect(second.name).toBe("Windows");
  expect(second.embeddedPck).toBe(true);
});

it("reuses a creator's Windows Desktop preset exactly as written", () => {
  const custom = `${webAndLinux}
[preset.2]
name="Store build"
platform="Windows Desktop"
export_filter="exclude"
include_filter="only/*"

[preset.2.options]
binary_format/embed_pck=false
binary_format/architecture="x86_64"
codesign/enable=true
`;
  const plan = planWindowsPreset(custom);
  expect(plan.ok).toBe(true);
  if (!plan.ok) return;
  expect(plan.name).toBe("Store build");
  expect(plan.text).toBeNull();
  expect(plan.embeddedPck).toBe(false);
});

it("refuses an existing Windows preset for another architecture instead of editing it", () => {
  const plan = planWindowsPreset(`${webAndLinux}
[preset.2]
name="Windows"
platform="Windows Desktop"

[preset.2.options]
binary_format/architecture="arm64"
`);
  expect(plan.ok).toBe(false);
  if (plan.ok) return;
  expect(plan.detail).toContain("arm64");
  expect(plan.detail).toContain("x86_64");
  expect(plan.detail).toContain("left untouched");
});

it("refuses ambiguous Windows presets instead of guessing", () => {
  const plan = planWindowsPreset(`${webAndLinux}
[preset.2]
name="Windows A"
platform="Windows Desktop"

[preset.3]
name="Windows B"
platform="Windows Desktop"
`);
  expect(plan.ok).toBe(false);
  if (plan.ok) return;
  expect(plan.detail).toContain("Windows A");
  expect(plan.detail).toContain("Windows B");
  expect(plan.detail).toContain("Keep one");
});

it("avoids a preset name another platform already uses", () => {
  const plan = planWindowsPreset(`${webAndLinux}
[preset.2]
name="Windows"
platform="Linux"
`);
  expect(plan.ok).toBe(true);
  if (!plan.ok) return;
  expect(plan.name).toBe("Windows Desktop");
  expect(plan.text).toContain('name="Windows Desktop"');
});

it("fills the first free preset index so Godot keeps reading past it", () => {
  const plan = planWindowsPreset(`[preset.0]
name="Web"
platform="Web"

[preset.0.options]
variant/thread_support=false

[preset.2]
name="Later"
platform="Linux"

[preset.2.options]
binary_format/architecture="x86_64"
`);
  expect(plan.ok).toBe(true);
  if (!plan.ok) return;
  expect(plan.text).toContain('[preset.1]\nname="Windows"');
});

it("refuses orphan preset options instead of writing an ambiguous block", () => {
  const plan = planWindowsPreset(`[preset.0]
name="Web"
platform="Web"

[preset.1]
name="Linux"
platform="Linux"

[preset.2.options]
binary_format/architecture="x86_64"
`);
  expect(plan.ok).toBe(false);
  if (plan.ok) return;
  expect(plan.detail).toContain("[preset.2.options]");
});

it("starts a missing preset file at preset 0", () => {
  const plan = planWindowsPreset(null);
  expect(plan.ok).toBe(true);
  if (!plan.ok) return;
  expect(plan.text).not.toBeNull();
  expect(plan.text!.startsWith('[preset.0]\nname="Windows"')).toBe(true);
});
