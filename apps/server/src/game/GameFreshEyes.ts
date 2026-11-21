// @effect-diagnostics nodeBuiltinImport:off -- Reads the game's BRIEF.md beside the pictures it is shown.
/**
 * Fresh eyes: a separate model, which knows only what a picture is meant to show and the game's
 * brief, names the picture's biggest visible defects. An agent judging its own renders sees what
 * it meant to build; across one 14-run model bench a blind judge named defects (proportions,
 * limbs, faces, props) the agents had looked at and shipped. The thread's own model answers, on
 * T3's one-shot image review, so any provider that can attach images takes part.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { ThreadId } from "@kurambit/contracts";

import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

const Defects = Schema.Struct({
  defects: Schema.Array(Schema.String.check(Schema.isMaxLength(600))).check(Schema.isMaxLength(5)),
});

const BRIEF_MOST = 1500;

const prompt = (about: string, brief: string) =>
  [
    "You are seeing these pictures for the first time. They show " + about + ".",
    brief === "" ? "" : `They are for a game made from this brief:\n"""\n${brief}\n"""`,
    "Judge them as an asset or screen in a polished game on Steam or itch.io. Name the three biggest problems a player or an art director would see, most important first. Each one concrete: which part, what is wrong with it, and what it should be instead. Only what the pictures show: no praise, no score, no guesses about code.",
  ]
    .filter((line) => line !== "")
    .join("\n\n");

export class GameFreshEyes extends Context.Service<
  GameFreshEyes,
  {
    /** The defects, as lines for the agent; a review that cannot run says why, never fails. */
    readonly review: (input: {
      readonly threadId: ThreadId;
      readonly root: string;
      readonly images: ReadonlyArray<string>;
      readonly about: string | undefined;
    }) => Effect.Effect<string>;
  }
>()("kurambit/game/GameFreshEyes") {}

const make = Effect.gen(function* () {
  const textGeneration = yield* TextGeneration.TextGeneration;
  const threads = yield* ThreadManagement.ThreadManagementService;

  const review = (input: {
    readonly threadId: ThreadId;
    readonly root: string;
    readonly images: ReadonlyArray<string>;
    readonly about: string | undefined;
  }) =>
    Effect.gen(function* () {
      const shell = yield* threads.getThreadShell(input.threadId);
      if (shell === null) return "Fresh eyes could not look: the thread is gone.";
      const brief = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(input.root, "BRIEF.md"), "utf8").catch(() => ""),
      );
      const answer = yield* textGeneration.generateImageReview({
        cwd: input.root,
        prompt: prompt(
          input.about ?? "a 3D model made for the game",
          brief.trim().slice(0, BRIEF_MOST),
        ),
        imagePaths: input.images,
        outputSchema: Defects,
        modelSelection: shell.modelSelection,
      });
      const { defects } = yield* Schema.decodeUnknownEffect(Defects)(answer);
      return defects.length === 0
        ? "Fresh eyes (a separate model shown only the picture, what it shows and the brief) saw no problem worth naming."
        : [
            "Fresh eyes (a separate model shown only the picture, what it shows and the brief):",
            ...defects.map((defect, index) => `${index + 1}. ${defect}`),
          ].join("\n");
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          `Fresh eyes could not look: ${("detail" in error && typeof error.detail === "string" ? error.detail : error.message).slice(0, 300)}`,
        ),
      ),
      Effect.withSpan("GameFreshEyes.review"),
    );

  return GameFreshEyes.of({ review });
});

export const layer = Layer.effect(GameFreshEyes, make);
