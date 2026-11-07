import { describe, expect, it } from "@effect/vitest";
import { describeProbe } from "./gameChromium.ts";
import { performanceOf } from "./playPerf.ts";

const gpu = {
  software: false,
  renderer: "ANGLE (Intel, Iris Xe)",
  probe: "gl-egl: RENDERER=ANGLE",
};
const record = {
  frames: 4800,
  seconds: 80,
  fps: 59.9,
  low1Fps: 48.2,
  gpuMs: 9.1,
  scale: 0.8,
  width: 1280,
  height: 720,
  software: false,
  renderer: "ANGLE (Intel, Iris Xe)",
};

describe("performanceOf", () => {
  it("never measures a play drawn in software, and says it is the harness's fault with the probe's output", () => {
    const probe = describeProbe([
      { args: ["--use-angle=gl-egl"], dom: "" },
      { args: ["--use-angle=vulkan"], dom: "<html><body></body></html>" },
    ]);
    const fact = performanceOf(
      { ...record, software: true, renderer: "SwiftShader" },
      { software: true, renderer: null, probe },
      null,
    );
    expect(fact.status).toBe("not-measured");
    if (fact.status !== "not-measured") return;
    expect(fact.why).toMatch(/^a harness fault on this machine, not the game's/);
    expect(fact.why).toContain("gl-egl: printed nothing; vulkan: printed no renderer");
    expect(fact.retry).toBe(false);
  });

  it("keeps a slow reading on a busy machine out of the facts, and a smooth one in", () => {
    const busy = { cores: 8, stalled: 0.5, load: 9 };
    expect(performanceOf({ ...record, fps: 31 }, gpu, busy).status).toBe("not-measured");
    expect(performanceOf(record, gpu, busy)).toEqual({
      status: "measured",
      value: {
        fps: 59.9,
        low1: 48.2,
        gpuMs: 9.1,
        scale: 0.8,
        width: 1280,
        height: 720,
        frames: 4800,
      },
    });
  });

  it("says a shell without frame stats is the game's copy, not a failure to retry", () => {
    const fact = performanceOf("none", gpu, null);
    expect(fact.status === "not-measured" && fact.retry).toBe(false);
  });
});
