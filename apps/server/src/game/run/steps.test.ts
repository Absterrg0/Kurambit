import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { GameOperationError, ThreadId } from "@kurambit/contracts";
import { PreviewBrowserInstallingError } from "../../preview/PreviewBrowser.ts";
import type * as GameService from "../GameService.ts";
import { bootStep } from "./steps.ts";

// The step builds its check once and runs that effect on every try.
const boot = (
  check: () => Effect.Effect<{ ok: boolean }, GameOperationError>,
  player: {
    readonly engine: "three" | "unity";
    readonly prepare: () => Effect.Effect<never, GameOperationError>;
  } = { engine: "three", prepare: () => Effect.die("a three.js game builds no player") },
) =>
  bootStep(
    {
      check: () => Effect.suspend(check),
      preparePlayer: () => Effect.suspend(player.prepare),
    } as unknown as GameService.GameService["Service"],
    {
      creator: ThreadId.make("creator"),
      owner: "run",
      root: "/g",
      engine: player.engine,
      log: () => Effect.void,
    },
  );

const refusal = (reason: GameOperationError["reason"], cause?: unknown) =>
  new GameOperationError({ operation: "three-check", path: "/g", reason, detail: "why", cause });

it.effect("a browser install in progress spends no boot try", () =>
  Effect.gen(function* () {
    let calls = 0;
    const installing = new PreviewBrowserInstallingError({
      downloadedBytes: 1,
      totalBytes: 2,
      unpacking: false,
    });
    const result = yield* boot(() =>
      ++calls <= 5
        ? Effect.fail(refusal("busy", installing))
        : Effect.succeed({ ok: true, errors: [] }),
    );
    expect(calls).toBe(6);
    expect(result).toEqual({ kind: "boot", ok: true, detail: "boot clean" });
  }),
);

it.effect(
  "a browser that cannot be had is not measured, waiting cannot clear it, and it is never the build's",
  () =>
    Effect.gen(function* () {
      const missing = yield* boot(() => Effect.fail(refusal("tool-missing"))).pipe(Effect.flip);
      expect(missing).toMatchObject({ _tag: "GameRunToolFailed", standing: true, reason: "why" });
      const lost = yield* boot(() => Effect.fail(refusal("tool-failed"))).pipe(Effect.flip);
      expect(lost).toMatchObject({ _tag: "GameRunToolFailed", standing: false });
    }),
);

// Another operation holding the game says nothing about the build.
it.effect("a busy game is not measured, never a boot failure", () =>
  Effect.gen(function* () {
    const handedBack = yield* boot(() => Effect.fail(refusal("busy"))).pipe(Effect.flip);
    expect(handedBack._tag).toBe("GameRunGameBusy");
  }),
);

it.effect("the build's own fault is the boot verdict", () =>
  Effect.gen(function* () {
    const result = yield* boot(() => Effect.fail(refusal("command-failed")));
    expect(result).toEqual({ kind: "boot", ok: false, detail: "why" });
  }),
);

// A refusal of our own request to build the player is ours, never the build's
// verdict: it pauses the run with why, waiting cannot clear it.
it.effect("a player build refused as our own request is not measured, never a boot verdict", () =>
  Effect.gen(function* () {
    const refused = yield* boot(() => Effect.succeed({ ok: true, errors: [] }), {
      engine: "unity",
      prepare: () =>
        Effect.fail(
          new GameOperationError({
            operation: "Explore session",
            path: "/g",
            reason: "invalid-input",
            detail: "The game sources could not be identified before the Unity session ran.",
          }),
        ),
    }).pipe(Effect.flip);
    expect(refused).toMatchObject({ _tag: "GameRunToolFailed", standing: true });
    const failed = yield* boot(() => Effect.succeed({ ok: true, errors: [] }), {
      engine: "unity",
      prepare: () => Effect.fail(refusal("command-failed")),
    });
    expect(failed).toMatchObject({ kind: "boot", ok: false });
  }),
);
