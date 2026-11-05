import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { GameOperationError, ThreadId } from "@kurambit/contracts";
import { PreviewBrowserInstallingError } from "../../preview/PreviewBrowser.ts";
import type * as GameService from "../GameService.ts";
import { bootStep } from "./steps.ts";

// The step builds its check once and runs that effect on every try.
const boot = (check: () => Effect.Effect<{ ok: boolean }, GameOperationError>) =>
  bootStep(
    {
      check: () => Effect.suspend(check),
      preparePlayer: () => Effect.die("a three.js game builds no player"),
    } as unknown as GameService.GameService["Service"],
    {
      creator: ThreadId.make("creator"),
      owner: "run",
      root: "/g",
      lane: "three",
      log: () => Effect.void,
      memoryWaitsLeft: true,
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

it.effect("a browser that cannot be had fails the step, never the build", () =>
  Effect.gen(function* () {
    const result = yield* boot(() => Effect.fail(refusal("tool-missing")));
    expect(result).toEqual({ kind: "failed", reason: "boot check could not run: why" });
  }),
);
