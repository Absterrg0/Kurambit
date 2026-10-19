import { it, expect } from "@effect/vitest";
import { parseGodotViewport } from "./godotViewport.ts";

const project = (display: string) => `[application]\nconfig/name="Game"\n\n${display}`;

it("reads the design resolution a Godot project sets", () => {
  expect(
    parseGodotViewport(
      project("[display]\n\nwindow/size/viewport_width=1280\nwindow/size/viewport_height=720\n"),
    ),
  ).toEqual({ width: 1280, height: 720 });
});

it("falls back per side and ignores values that are not a resolvable viewport", () => {
  // Godot writes floats when a project stores them; only integer pixels are usable.
  expect(
    parseGodotViewport(project("[display]\nwindow/size/viewport_width=960.0\nwin/size=1\n")),
  ).toEqual({ width: 1152, height: 648 });
  expect(parseGodotViewport("")).toEqual({ width: 1152, height: 648 });
  expect(parseGodotViewport(project("[display]\nwindow/size/viewport_height=4\n"))).toEqual({
    width: 1152,
    height: 648,
  });
});
