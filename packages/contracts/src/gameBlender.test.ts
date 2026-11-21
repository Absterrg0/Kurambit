import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { GameBlenderCharacterInput } from "./gameBlender.ts";

const decode = Schema.decodeUnknownSync(GameBlenderCharacterInput);

describe("game_blender op character input", () => {
  it("keeps an earlier call's spring chains on a body as they were", () => {
    const old = decode({
      name: "fox",
      body: "none",
      chains: [{ name: "tail", parent: "pelvis", bones: 4, direction: [0, 1, 0], length: 0.6 }],
    });
    expect(old.chains?.[0]).not.toHaveProperty("kind");
  });

  it("reads a rig's chains as the model's chains", () => {
    const rigged = decode({
      name: "beetle",
      rig: "chains",
      chains: [
        {
          name: "body",
          kind: "spine",
          part: ["Thorax"],
          points: [
            [0, 0.7, 0.36],
            [0, -0.48, 0.36],
          ],
        },
        { name: "leg1_l", kind: "leg", parent: "body", part: "Leg1_l", bones: 3 },
      ],
      rigid: { Eye_l: "body" },
    });
    expect(rigged.chains?.[1]).toMatchObject({ kind: "leg", part: "Leg1_l" });
  });
});
