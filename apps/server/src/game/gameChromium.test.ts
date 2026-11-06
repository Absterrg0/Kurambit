// Which backend game browsers draw with: the first that drew on hardware,
// never a software renderer taken for a GPU.
import { describe, expect, it } from "@effect/vitest";
import { backendCandidates, chooseBackend, parseProbeRenderer } from "./gameChromium.ts";

const INTEL = "ANGLE (Intel, Mesa Intel(R) Iris(R) Xe Graphics (ADL GT2), OpenGL ES 3.2)";
const SWIFTSHADER =
  "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)";

describe("game browser backend", () => {
  it("reads the probe page's renderer, and none without WebGL", () => {
    expect(parseProbeRenderer(`<html><body>RENDERER=${INTEL}</body></html>\n`)).toBe(INTEL);
    expect(parseProbeRenderer("<body>RENDERER=no-webgl</body>")).toBeNull();
    expect(parseProbeRenderer("")).toBeNull();
  });

  it("takes the first hardware backend on Linux, else SwiftShader", () => {
    const [egl, vulkan] = backendCandidates("linux");
    expect(
      chooseBackend("linux", [
        { args: egl!, renderer: SWIFTSHADER },
        { args: vulkan!, renderer: "ANGLE (Intel, Vulkan 1.4 (Intel(R) Graphics))" },
      ]),
    ).toMatchObject({ args: vulkan, software: false });
    expect(
      chooseBackend("linux", [
        { args: egl!, renderer: "llvmpipe (LLVM 19.1, 256 bits)" },
        { args: vulkan!, renderer: null },
      ]),
    ).toEqual({
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
      renderer: null,
      software: true,
    });
  });

  it("keeps the default elsewhere and only records its renderer", () => {
    expect(chooseBackend("darwin", [{ args: [], renderer: "Apple M2" }])).toEqual({
      args: [],
      renderer: "Apple M2",
      software: false,
    });
  });
});
