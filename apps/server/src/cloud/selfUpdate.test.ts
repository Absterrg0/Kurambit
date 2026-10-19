import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ServerSelfUpdateError, ThreadId } from "@t3tools/contracts";

import * as Cause from "effect/Cause";

import * as Effect from "effect/Effect";

import * as ServerSelfUpdate from "./selfUpdate.ts";

it.layer(NodeServices.layer)("server self update", (it) => {
  it.effect("marks running threads at the boot-service handoff", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "web",
        selfUpdate: {
          update: (_input, reportProgress = () => Effect.void) =>
            reportProgress("downloading").pipe(
              Effect.andThen(reportProgress("installing")),
              Effect.as({
                targetVersion: "1.1.0",
                method: "boot-service" as const,
                updateId: "update-id",
              }),
            ),
          commitDesktopUpdate: () => Effect.never,
        },
        prepare: Effect.sync(() => {
          events.push("prepare");
          return [ThreadId.make("thread-running")];
        }),
        clear: () => Effect.sync(() => void events.push("clear")),
      });

      yield* selfUpdate.update({ targetVersion: "1.1.0", continueRunningThreads: true }, (stage) =>
        Effect.sync(() => void events.push(stage)),
      );

      expect(events).toEqual(["downloading", "prepare", "installing"]);
    }),
  );

  it.effect("marks desktop threads only when the prepared update commits", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-running-desktop");
      const events: string[] = [];
      const commitError = new ServerSelfUpdateError({ reason: "install failed" });
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "desktop",
        selfUpdate: {
          update: (_input, reportProgress = () => Effect.void) =>
            reportProgress("installing").pipe(
              Effect.as({
                targetVersion: "1.2.0",
                method: "desktop-app" as const,
                desktopUpdateToken: "desktop-token",
              }),
            ),
          commitDesktopUpdate: () =>
            Effect.sync(() => events.push("commit")).pipe(Effect.andThen(Effect.fail(commitError))),
        },
        prepare: Effect.sync(() => {
          events.push("prepare");
          return [threadId];
        }),
        clear: (threadIds) => Effect.sync(() => void events.push(`clear:${threadIds.join(",")}`)),
      });

      yield* selfUpdate.update({ targetVersion: "1.2.0", continueRunningThreads: true }, (stage) =>
        Effect.sync(() => void events.push(stage)),
      );
      expect(events).toEqual(["installing"]);
      expect(yield* selfUpdate.commitDesktopUpdate("desktop-token").pipe(Effect.flip)).toBe(
        commitError,
      );
      expect(events).toEqual(["installing", "prepare", "commit", `clear:${threadId}`]);
      expect(yield* selfUpdate.commitDesktopUpdate("desktop-token").pipe(Effect.flip)).toBe(
        commitError,
      );
      expect(events).toEqual([
        "installing",
        "prepare",
        "commit",
        `clear:${threadId}`,
        "prepare",
        "commit",
        `clear:${threadId}`,
      ]);
    }),
  );

  it.effect("reports a failed continuation-marker cleanup", () =>
    Effect.gen(function* () {
      const updateError = new ServerSelfUpdateError({ reason: "update failed" });
      const clearError = new ServerSelfUpdateError({ reason: "marker cleanup failed" });
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "web",
        selfUpdate: {
          update: (_input, reportProgress = () => Effect.void) =>
            reportProgress("installing").pipe(Effect.andThen(Effect.fail(updateError))),
          commitDesktopUpdate: () => Effect.never,
        },
        prepare: Effect.succeed([ThreadId.make("thread-cleanup-failure")]),
        clear: () => Effect.fail(clearError),
      });

      expect(
        yield* selfUpdate
          .update({ targetVersion: "1.1.0", continueRunningThreads: true })
          .pipe(Effect.flip),
      ).toBe(clearError);
    }),
  );

  it.effect("keeps continuation markers after the boot-service handoff is accepted", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "web",
        selfUpdate: {
          update: (
            _input,
            reportProgress = () => Effect.void,
            onHandoffAccepted = () => Effect.void,
          ) =>
            reportProgress("installing").pipe(
              Effect.andThen(onHandoffAccepted()),
              Effect.andThen(Effect.interrupt),
            ),
          commitDesktopUpdate: () => Effect.never,
        },
        prepare: Effect.sync(() => {
          events.push("prepare");
          return [ThreadId.make("thread-accepted-boot-handoff")];
        }),
        clear: () => Effect.sync(() => void events.push("clear")),
      });

      const exit = yield* selfUpdate
        .update({ targetVersion: "1.1.0", continueRunningThreads: true })
        .pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
      expect(events).toEqual(["prepare"]);
    }),
  );

  it.effect("keeps continuation markers after the desktop handoff is accepted", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "desktop",
        selfUpdate: {
          update: () =>
            Effect.succeed({
              targetVersion: "1.2.0",
              method: "desktop-app" as const,
              desktopUpdateToken: "accepted-desktop-token",
            }),
          commitDesktopUpdate: (_requestId, onHandoffAccepted = () => Effect.void) =>
            onHandoffAccepted().pipe(Effect.andThen(Effect.interrupt)),
        },
        prepare: Effect.sync(() => {
          events.push("prepare");
          return [ThreadId.make("thread-accepted-desktop-handoff")];
        }),
        clear: () => Effect.sync(() => void events.push("clear")),
      });

      yield* selfUpdate.update({
        targetVersion: "1.2.0",
        continueRunningThreads: true,
      });
      const exit = yield* selfUpdate
        .commitDesktopUpdate("accepted-desktop-token")
        .pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
      expect(events).toEqual(["prepare"]);
    }),
  );

  it.effect("clears continuation markers for mixed failure and interrupt causes", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const commitError = new ServerSelfUpdateError({ reason: "install failed" });
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "desktop",
        selfUpdate: {
          update: () =>
            Effect.succeed({
              targetVersion: "1.2.0",
              method: "desktop-app" as const,
              desktopUpdateToken: "failed-desktop-token",
            }),
          commitDesktopUpdate: (_requestId, onHandoffAccepted = () => Effect.void) =>
            onHandoffAccepted().pipe(
              Effect.andThen(
                Effect.failCause(
                  Cause.fromReasons([
                    Cause.makeFailReason(commitError),
                    Cause.makeInterruptReason(),
                  ]),
                ),
              ),
            ),
        },
        prepare: Effect.sync(() => [ThreadId.make("thread-failed-desktop-install")]),
        clear: () => Effect.sync(() => void events.push("clear")),
      });

      yield* selfUpdate.update({
        targetVersion: "1.2.0",
        continueRunningThreads: true,
      });
      const exit = yield* selfUpdate.commitDesktopUpdate("failed-desktop-token").pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(false);
      }
      expect(events).toEqual(["clear"]);
    }),
  );

  it.effect("rejects all update paths without HTTP, filesystem, or launcher services", () =>
    Effect.gen(function* () {
      const service = yield* ServerSelfUpdate.make();
      expect(
        (yield* service.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason,
      ).toContain("unavailable");
      expect(
        (yield* service.commitDesktopUpdate("saved-update").pipe(Effect.flip)).reason,
      ).toContain("unavailable");
      expect(
        ServerSelfUpdate.resolveServerSelfUpdateCapability({
          desktopManaged: true,
          launcherManaged: true,
        }),
      ).toBeNull();
    }),
  );
});
