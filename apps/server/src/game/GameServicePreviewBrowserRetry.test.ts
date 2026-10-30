import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import { withPreviewBrowserInstallRetries } from "./GameService.ts";

const installing = (downloadedBytes = 119_000_000) =>
  new PreviewBrowser.PreviewBrowserInstallingError({
    downloadedBytes,
    totalBytes: 120_477_194,
    unpacking: false,
  });

const permanent = () => new PreviewBrowser.PreviewBrowserInstallError({ detail: "disk failed" });

const unsupported = () =>
  new PreviewBrowser.PreviewBrowserUnsupportedError({ platform: "linux", arch: "ia32" });

it.effect("joins the same managed install: first InstallingError then ready succeeds", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const executable = Ref.updateAndGet(calls, (count) => count + 1).pipe(
      Effect.flatMap((count) =>
        count === 1 ? Effect.fail(installing()) : Effect.succeed("/browser/chrome-headless-shell"),
      ),
    );
    const resolved = yield* withPreviewBrowserInstallRetries(executable);
    expect(resolved).toBe("/browser/chrome-headless-shell");
    expect(yield* Ref.get(calls)).toBe(2);
  }),
);

it.effect("a permanent install failure retries nothing and stays honest", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const executable = Ref.updateAndGet(calls, (count) => count + 1).pipe(
      Effect.flatMap(() => Effect.fail(permanent())),
    );
    const error = yield* withPreviewBrowserInstallRetries(executable).pipe(Effect.flip);
    expect(error._tag).toBe("PreviewBrowserInstallError");
    expect(yield* Ref.get(calls)).toBe(1);
  }),
);

it.effect("an unsupported platform retries nothing", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const executable = Ref.updateAndGet(calls, (count) => count + 1).pipe(
      Effect.flatMap(() => Effect.fail(unsupported())),
    );
    const error = yield* withPreviewBrowserInstallRetries(executable).pipe(Effect.flip);
    expect(error._tag).toBe("PreviewBrowserUnsupportedError");
    expect(yield* Ref.get(calls)).toBe(1);
  }),
);

it.effect("exhaustion after two extra joins stays InstallingError", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const executable = Ref.updateAndGet(calls, (count) => count + 1).pipe(
      Effect.flatMap(() => Effect.fail(installing())),
    );
    const error = yield* withPreviewBrowserInstallRetries(executable).pipe(Effect.flip);
    expect(error._tag).toBe("PreviewBrowserInstallingError");
    expect(yield* Ref.get(calls)).toBe(3);
  }),
);

it.effect("interruption during a join stays interruption, never a verdict", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const started = yield* Deferred.make<void>();
    const executable = Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Deferred.await(gate)),
      Effect.as("/browser/chrome-headless-shell"),
    );
    const fiber = yield* withPreviewBrowserInstallRetries(executable).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);
    expect(exit._tag).toBe("Failure");
    if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  }),
);
