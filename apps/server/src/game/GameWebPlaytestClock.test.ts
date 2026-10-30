// @effect-diagnostics globalTimers:off -- Slow captures are real wall-clock work proving nominal time stays independent.
import { describe, expect, it } from "vite-plus/test";
import type { Clock, Keyboard, Mouse } from "playwright-core";
import { dragWithClock, holdKeysWithClock, toPlaywrightKey } from "./GameWebPlaytest.ts";
import { runCaptureWindow } from "./playtestTiming.ts";

// Fakes use the public typed Playwright surfaces, so a DIY CDP shape with a
// fictional resume policy cannot satisfy them: `{ policy: "disabled" }` has no
// `runFor` and fails typecheck, which is exactly the bug this driver removes.
type FakeClock = Pick<Clock, "runFor">;
type FakeKeyboard = Pick<Keyboard, "down" | "up">;
type FakeMouse = Pick<Mouse, "move" | "down" | "up" | "click">;

const fakeClock = (calls: number[], fail?: Error) =>
  ({
    runFor: async (ticks: number) => {
      if (fail) throw fail;
      calls.push(ticks);
    },
  }) satisfies FakeClock;

const fakeKeyboard = (events: string[]) =>
  ({
    down: async (key: string) => {
      events.push(`down:${key}`);
    },
    up: async (key: string) => {
      events.push(`up:${key}`);
    },
  }) satisfies FakeKeyboard;

const fakeMouse = (events: string[]) =>
  ({
    move: async (x: number, y: number) => {
      events.push(`move:${Math.round(x)},${Math.round(y)}`);
    },
    down: async () => {
      events.push("down");
    },
    up: async () => {
      events.push("up");
    },
    click: async (x: number, y: number) => {
      events.push(`click:${Math.round(x)},${Math.round(y)}`);
    },
  }) satisfies FakeMouse;

describe("controlled-clock driver seam", () => {
  it("maps the Space key to the DOM value Playwright expects", () => {
    expect(toPlaywrightKey("Space")).toBe(" ");
    expect(toPlaywrightKey(" ")).toBe(" ");
    expect(toPlaywrightKey("ArrowRight")).toBe("ArrowRight");
    expect(toPlaywrightKey("w")).toBe("w");
  });

  it("holds keys for nominal time and releases them in reverse", async () => {
    const runFor: number[] = [];
    const events: string[] = [];
    const captures: number[] = [];
    await holdKeysWithClock({
      keyboard: fakeKeyboard(events),
      clock: fakeClock(runFor),
      keys: ["Shift", "w"],
      holdMs: 200,
      captureEveryMs: 100,
      capture: async (elapsed) => {
        captures.push(elapsed);
      },
    });
    expect(runFor.reduce((sum, ticks) => sum + ticks, 0)).toBe(200);
    expect(captures).toEqual([100]);
    expect(events).toEqual(["down:Shift", "down:w", "up:w", "up:Shift"]);
  });

  it("keeps nominal time independent of slow capture wall time", async () => {
    const runFor: number[] = [];
    const events: string[] = [];
    await holdKeysWithClock({
      keyboard: fakeKeyboard(events),
      clock: fakeClock(runFor),
      keys: ["ArrowRight"],
      holdMs: 250,
      captureEveryMs: 100,
      capture: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
      },
    });
    expect(runFor.reduce((sum, ticks) => sum + ticks, 0)).toBe(250);
    expect(events[0]).toBe("down:ArrowRight");
    expect(events.at(-1)).toBe("up:ArrowRight");
  });

  it("releases keys on abort without advancing the clock", async () => {
    const runFor: number[] = [];
    const events: string[] = [];
    const controller = new AbortController();
    controller.abort();
    await expect(
      holdKeysWithClock({
        keyboard: fakeKeyboard(events),
        clock: fakeClock(runFor),
        signal: controller.signal,
        keys: ["a"],
        holdMs: 500,
      }),
    ).rejects.toThrow();
    expect(events).toEqual(["down:a", "up:a"]);
    expect(runFor).toEqual([]);
  });

  it("releases keys when the clock cannot advance instead of freezing paused", async () => {
    const events: string[] = [];
    await expect(
      holdKeysWithClock({
        keyboard: fakeKeyboard(events),
        clock: fakeClock([], new Error("clock unsupported")),
        keys: ["b"],
        holdMs: 100,
      }),
    ).rejects.toThrow("clock unsupported");
    // Cleanup ran: no stuck key, and the caller sees the failure honestly.
    expect(events).toEqual(["down:b", "up:b"]);
  });

  it("releases earlier keys when a later key cannot be pressed", async () => {
    const events: string[] = [];
    await expect(
      holdKeysWithClock({
        keyboard: {
          down: async (key) => {
            if (key === "unsupported") throw new Error("unknown key");
            events.push(`down:${key}`);
          },
          up: async (key) => {
            events.push(`up:${key}`);
          },
        },
        clock: fakeClock([]),
        keys: ["Shift", "unsupported"],
        holdMs: 100,
      }),
    ).rejects.toThrow("unknown key");
    expect(events).toEqual(["down:Shift", "up:Shift"]);
  });

  it("releases the mouse button when a drag aborts", async () => {
    const runFor: number[] = [];
    const events: string[] = [];
    const controller = new AbortController();
    controller.abort();
    await expect(
      dragWithClock({
        mouse: fakeMouse(events),
        clock: fakeClock(runFor),
        signal: controller.signal,
        from: { x: 10, y: 10 },
        to: { x: 60, y: 10 },
        holdMs: 200,
      }),
    ).rejects.toThrow();
    expect(events[0]).toBe("move:10,10");
    expect(events[1]).toBe("down");
    expect(events.at(-1)).toBe("up");
    expect(runFor).toEqual([]);
  });

  it("releases the mouse button when the clock fails mid-drag", async () => {
    const events: string[] = [];
    await expect(
      dragWithClock({
        mouse: fakeMouse(events),
        clock: fakeClock([], new Error("runFor failed")),
        from: { x: 0, y: 0 },
        to: { x: 50, y: 0 },
        holdMs: 150,
      }),
    ).rejects.toThrow("runFor failed");
    expect(events[0]).toBe("move:0,0");
    expect(events).toContain("down");
    expect(events.at(-1)).toBe("up");
  });

  it("captures during steps in nominal order while paused", async () => {
    const runFor: number[] = [];
    const captures: number[] = [];
    await runCaptureWindow({
      duration: 300,
      captureInterval: 100,
      clock: fakeClock(runFor),
      capture: async (elapsed) => {
        captures.push(elapsed);
      },
    });
    expect(captures).toEqual([100, 200]);
    expect(runFor.reduce((sum, ticks) => sum + ticks, 0)).toBe(300);
  });
});
