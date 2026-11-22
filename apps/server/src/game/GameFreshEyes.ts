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

/** What a check's frames show, in their order: the page as opened (boot), then play. */
export const checkFramesAbout = (entries: ReadonlyArray<string>) =>
  entries.length > 1 && entries[0] === "boot"
    ? "a browser game: first the page as a player opens it, then a moment of play"
    : "a moment of play in a browser game";

const prompt = (about: string, brief: string) =>
  [
    "You are seeing these pictures for the first time. They show " + about + ".",
    brief === "" ? "" : `They are for a game made from this brief:\n"""\n${brief}\n"""`,
    "Judge them as an asset or screen in a polished game on Steam or itch.io. Name the three biggest problems a player or an art director would see, most important first. Each one concrete: which part, what is wrong with it, and what it should be instead. Only what the pictures show: no praise, no score, no guesses about code.",
  ]
    .filter((line) => line !== "")
    .join("\n\n");

interface ReviewInput {
  readonly threadId: ThreadId;
  readonly root: string;
  readonly images: ReadonlyArray<string>;
  readonly about: string | undefined;
}

export class GameFreshEyes extends Context.Service<
  GameFreshEyes,
  {
    /** The defects, as lines for the agent; a review that cannot run says why, never fails. */
    readonly review: (input: ReviewInput) => Effect.Effect<string>;
    /**
     * The defects themselves, biggest first (empty: nothing worth naming), or why the review
     * could not run.
     */
    readonly defects: (
      input: ReviewInput,
    ) => Effect.Effect<
      | { readonly _tag: "seen"; readonly defects: ReadonlyArray<string> }
      | { readonly _tag: "failed"; readonly reason: string }
    >;
  }
>()("kurambit/game/GameFreshEyes") {}

const make = Effect.gen(function* () {
  const textGeneration = yield* TextGeneration.TextGeneration;
  const threads = yield* ThreadManagement.ThreadManagementService;

  const defects = (input: ReviewInput) =>
    Effect.gen(function* () {
      const shell = yield* threads.getThreadShell(input.threadId);
      if (shell === null) return { _tag: "failed" as const, reason: "the thread is gone" };
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
      const decoded = yield* Schema.decodeUnknownEffect(Defects)(answer);
      return { _tag: "seen" as const, defects: decoded.defects };
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          _tag: "failed" as const,
          reason: ("detail" in error && typeof error.detail === "string"
            ? error.detail
            : error.message
          ).slice(0, 300),
        }),
      ),
      Effect.withSpan("GameFreshEyes.defects"),
    );

  const review = (input: ReviewInput) =>
    Effect.map(defects(input), (seen) =>
      seen._tag === "failed"
        ? `Fresh eyes could not look: ${seen.reason}`
        : seen.defects.length === 0
          ? "Fresh eyes (a separate model shown only the picture, what it shows and the brief) saw no problem worth naming."
          : [
              "Fresh eyes (a separate model shown only the picture, what it shows and the brief):",
              ...seen.defects.map((defect, index) => `${index + 1}. ${defect}`),
            ].join("\n"),
    );

  return GameFreshEyes.of({ review, defects });
});

export const layer = Layer.effect(GameFreshEyes, make);
