import { describe, expect, it } from "vite-plus/test";

import { assetName, soundGroups, soundPurpose } from "./gameArt.logic";

describe("a sound in the Art list", () => {
  it("is named as a person says it, without its folder or extension", () => {
    expect(assetName("web/assets/sfx/step-grass.wav")).toBe("Step grass");
    expect(assetName("web/assets/music/lofi-night.wav")).toBe("Lofi night");
    expect(assetName("art/heroIdle_02.glb")).toBe("Hero idle 02");
  });

  it("is for what its folder says, then what its name says, else an effect", () => {
    expect(soundPurpose("web/assets/music/lofi-night.wav")).toBe("music");
    // The folder wins over a word in the name.
    expect(soundPurpose("web/assets/music/night-ambience.ogg")).toBe("music");
    expect(soundPurpose("web/assets/sfx/night-ambience.wav")).toBe("ambience");
    expect(soundPurpose("web/assets/sfx/step-wood.wav")).toBe("steps");
    expect(soundPurpose("web/assets/sfx/click.wav")).toBe("interface");
    expect(soundPurpose("web/assets/sfx/page.wav")).toBe("interface");
    expect(soundPurpose("web/assets/sfx/splash.wav")).toBe("effects");
    // "snapback" holds "back" only as letters, never as a word.
    expect(soundPurpose("web/assets/sfx/snapback.wav")).toBe("effects");
  });

  it("groups in one order, each group by name, with no empty group", () => {
    const groups = soundGroups(
      ["sfx/splash.wav", "sfx/bite.wav", "music/theme.ogg", "sfx/step-wood.wav"].map((path) => ({
        path,
      })),
    );
    expect(groups.map((group) => [group.label, group.sounds.map((sound) => sound.path)])).toEqual([
      ["Music", ["music/theme.ogg"]],
      ["Footsteps", ["sfx/step-wood.wav"]],
      ["Effects", ["sfx/bite.wav", "sfx/splash.wav"]],
    ]);
  });
});
