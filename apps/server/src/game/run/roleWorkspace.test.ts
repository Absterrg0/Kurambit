// @effect-diagnostics nodeBuiltinImport:off -- The copies are real folders on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ThreadId } from "@kurambit/contracts";
import { dropRunCopies, type RoleDeps } from "./roleWorkspace.ts";

it.effect("a finish never removes the copy of a role still running, and unbinds the rest", () =>
  Effect.gen(function* () {
    const base = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "run-copies-")),
    );
    const copies = NodePath.join(base, "run");
    for (const name of ["step-a", "step-b", "bot-c", "step-d.making"])
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(copies, name), { recursive: true }));
    const running = ThreadId.make("running");
    const idle = ThreadId.make("idle");
    const shells = new Map([
      [running, { worktreePath: NodePath.join(copies, "step-a"), activeRunId: "turn" }],
      [idle, { worktreePath: NodePath.join(copies, "step-b"), activeRunId: null }],
    ]);
    const unbound: string[] = [];
    const deps = {
      threads: {
        getThreadShell: (threadId: ThreadId) => Effect.succeed(shells.get(threadId) ?? null),
        dispatch: (command: { threadId: ThreadId }) =>
          Effect.sync(() => {
            unbound.push(command.threadId);
            shells.set(command.threadId, { worktreePath: null as never, activeRunId: null });
          }),
      },
      game: { closeLiveEditors: () => Effect.void },
    } as unknown as Pick<RoleDeps, "threads" | "game">;
    yield* dropRunCopies(deps, { copies, log: () => Effect.void }, [running, idle], false);
    expect((yield* Effect.promise(() => NodeFSP.readdir(copies))).toSorted()).toEqual(["step-a"]);
    expect(unbound).toEqual([idle]);
    yield* Effect.promise(() => NodeFSP.rm(base, { recursive: true, force: true }));
  }),
);
