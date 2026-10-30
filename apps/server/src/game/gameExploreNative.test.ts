import { describe, expect, it } from "vitest";
import {
  exploreStepNominalMs,
  exploreStepsNominalMs,
  sanitizeNativeObservation,
  webRejectsForSteps,
  nativeChildEnv,
  nativeGodotArgs,
  nativeXvfbArgs,
} from "./gameExploreNative.ts";

describe("exploreStepsNominalMs", () => {
  it("keeps web accounting and prices ui at 100ms with inspect free", () => {
    expect(exploreStepNominalMs({ press: "Space" })).toBe(50);
    expect(exploreStepNominalMs({ waitMs: 300 })).toBe(300);
    expect(exploreStepNominalMs({ key: "w", holdMs: 80 })).toBe(80);
    expect(exploreStepNominalMs({ ui: { id: "HUD.Play", action: "click" } })).toBe(100);
    expect(exploreStepNominalMs({ inspect: { path: "GameState" } })).toBe(0);
    expect(
      exploreStepsNominalMs([{ press: "Space" }, { ui: { id: "HUD.Play", action: "click" } }]),
    ).toBe(150);
  });
});

describe("webRejectsForSteps", () => {
  it("rejects ui and inspect on web and accepts the shared steps", () => {
    expect(webRejectsForSteps([{ press: "Space" }, { waitMs: 10 }])).toEqual([]);
    const rejects = webRejectsForSteps([
      { ui: { id: "HUD.Play", action: "click" } },
      { inspect: { path: "GameState" } },
    ]);
    expect(rejects).toHaveLength(2);
    expect(rejects[0]).toContain("target native");
  });
});

describe("sanitizeNativeObservation", () => {
  it("bounds text, controls, errors and inspect values while keeping play values", () => {
    const raw = {
      probe: {
        gameState: { mana: 3, won: false, nested: { big: 1 } },
        player: { x: 1, y: 2, z: 0 },
      },
      screenText: { "HUD.Mana": "Mana: 3", "HUD.Bad": 42 },
      ui: [
        {
          id: "HUD.Play",
          kind: "button",
          label: "Play",
          enabled: true,
          rect: { x: 1, y: 2, width: 3, height: 4 },
        },
        { id: "HUD.Broken", kind: "button", label: "x", enabled: true, rect: { x: 1 } },
      ],
      errors: [
        { message: "boom", where: "res://scripts/main.gd:12" },
        { message: 42, where: "nowhere" },
      ],
      uiResults: [{ id: "HUD.Play", action: "click", received: true, detail: "mouse" }],
      inspections: [
        {
          path: "GameState",
          values: { mana: 3, hand: [1, 2], deep: { o: 1 }, name: "x".repeat(400) },
        },
      ],
    };
    const clean = sanitizeNativeObservation(raw);
    expect(clean.probe?.gameState).toEqual({ mana: 3, won: false });
    expect(clean.screenText).toEqual({ "HUD.Mana": "Mana: 3" });
    expect(clean.ui).toHaveLength(1);
    expect(clean.errors).toEqual([{ message: "boom", where: "res://scripts/main.gd:12" }]);
    expect(clean.uiResults).toEqual([
      { id: "HUD.Play", action: "click", received: true, detail: "mouse" },
    ]);
    expect(clean.inspections[0]?.values).toEqual({ mana: 3, hand: [1, 2], name: "x".repeat(256) });
  });
});

describe("nativeGodotArgs", () => {
  it("never inherits a display and passes the window size in both modes", () => {
    const base = {
      projectDir: "/game/godot",
      scriptPath: "/game/builds/logs/x/explore.gd",
      requestPath: "/game/builds/logs/x/request.json",
      width: 960,
      height: 540,
    };
    const headed = nativeGodotArgs({ ...base, hasDisplay: true });
    expect(headed).toContain("--display-driver");
    expect(headed).toContain("960x540".replace("960x540", "960x540"));
    expect(headed).not.toContain("--headless");
    const headless = nativeGodotArgs({ ...base, hasDisplay: false });
    expect(headless).toContain("--headless");
    expect(headless).not.toContain("--display-driver");
  });

  it("wraps Godot in a private xvfb display", () => {
    const args = nativeXvfbArgs("/usr/bin/xvfb-run", "/bin/godot", ["--path", "x"], 960, 540);
    expect(args.slice(0, 4)).toEqual(["/usr/bin/xvfb-run", "-a", "-s", "-screen 0 960x540x24"]);
    expect(args).toContain("/bin/godot");
  });

  it("never lets a desktop display reach the child, even from a desktop shell", () => {
    const saved = {
      DISPLAY: process.env.DISPLAY,
      WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
      XAUTHORITY: process.env.XAUTHORITY,
    };
    process.env.DISPLAY = ":0";
    process.env.WAYLAND_DISPLAY = "wayland-0";
    process.env.XAUTHORITY = "/tmp/xauth";
    try {
      const env = nativeChildEnv({
        dir: "/tmp/x",
        dataDir: "/tmp/x/data",
        configDir: "/tmp/x/config",
        cacheDir: "/tmp/x/cache",
        env: {
          XDG_DATA_HOME: "/tmp/x/data",
          XDG_CONFIG_HOME: "/tmp/x/config",
          XDG_CACHE_HOME: "/tmp/x/cache",
        },
      });
      expect("DISPLAY" in env).toBe(false);
      expect("WAYLAND_DISPLAY" in env).toBe(false);
      expect("XAUTHORITY" in env).toBe(false);
      expect(env["XDG_DATA_HOME"]).toBe("/tmp/x/data");
    } finally {
      if (saved.DISPLAY === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = saved.DISPLAY;
      if (saved.WAYLAND_DISPLAY === undefined) delete process.env.WAYLAND_DISPLAY;
      else process.env.WAYLAND_DISPLAY = saved.WAYLAND_DISPLAY;
      if (saved.XAUTHORITY === undefined) delete process.env.XAUTHORITY;
      else process.env.XAUTHORITY = saved.XAUTHORITY;
    }
  });

  it("forces x11 under xvfb so Godot cannot pick Wayland", () => {
    const base = {
      projectDir: "/game/godot",
      scriptPath: "/game/builds/logs/x/explore.gd",
      requestPath: "/game/builds/logs/x/request.json",
      width: 960,
      height: 540,
    };
    const headed = nativeGodotArgs({ ...base, hasDisplay: true });
    expect(headed).toContain("--display-driver");
    expect(headed[headed.indexOf("--display-driver") + 1]).toBe("x11");
    expect(headed).not.toContain("--headless");
  });
});
