import { describe, expect, it } from "vite-plus/test";

import { gameNextLine } from "./gameNextLine";

describe("gameNextLine", () => {
  it("reads the reply's last line", () => {
    expect(gameNextLine("Added the dash.\n\nNext: give the boss a second phase\n")).toBe(
      "give the boss a second phase",
    );
    expect(gameNextLine("Done.\n**Next:** a pause menu")).toBe("a pause menu");
    expect(gameNextLine("Done.\n- Next: louder footsteps")).toBe("louder footsteps");
  });

  it("proposes nothing when the brief is done or the reply ends otherwise", () => {
    expect(gameNextLine("All of the brief plays.\nNext: none")).toBeNull();
    expect(gameNextLine("Next: None.")).toBeNull();
    expect(gameNextLine("Next: a boss\n\nI also fixed the camera.")).toBeNull();
    expect(gameNextLine("Next:")).toBeNull();
    expect(gameNextLine("")).toBeNull();
  });
});
