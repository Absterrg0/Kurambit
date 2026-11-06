// @effect-diagnostics nodeBuiltinImport:off -- A real repository on disk is what the run's builds live in.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { GameRun } from "@kurambit/contracts";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { checkpointRefForGameRun } from "../../checkpointing/Utils.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import type * as GameOperations from "../GameOperations.ts";
import type * as GameService from "../GameService.ts";
import { BuildName } from "./buildNames.ts";
import { buildStep, captureBuild, pruneBuilds } from "./builds.ts";
import * as Policy from "./policy.ts";
import { restoreBuild } from "./restoreRound.ts";
import { type RunState, freshState } from "./state.ts";

const layer = CheckpointStore.layer.pipe(
  Layer.provide(
    VcsDriverRegistry.layer.pipe(
      Layer.provide(VcsProcess.layer.pipe(Layer.provide(NodeServices.layer))),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const repo = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "run-builds-"));
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  git("init", "-q", "-b", "main");
  NodeFS.mkdirSync(NodePath.join(root, "godot"));
  NodeFS.writeFileSync(NodePath.join(root, "godot", "main.gd"), "extends Node\n");
  git("add", "-A");
  git("commit", "-qm", "game");
  return { root, git };
};

const game = {
  closeLiveEditors: () => Effect.void,
} as unknown as GameService.GameService["Service"];
// The run's own moves pass through the game's operation lock, held by nothing else here.
const lock = {
  operations: {
    exclusive: <A, E>(_root: string, _name: string, work: Effect.Effect<A, E>) => work,
  } as unknown as GameOperations.GameOperations["Service"],
  owner: "game-run:test",
  waitUntil: null,
};

it.effect("keeps a round beside its candidate, under names git can store, again and again", () =>
  Effect.gen(function* () {
    const { root, git } = repo();
    const checkpoints = yield* CheckpointStore.CheckpointStore;
    const runId = "run_mzx1:a";
    const capture = (name: string) => captureBuild({ checkpoints, lock }, root, runId, name);
    // Every kind of name the run makes, as real ids and times give them.
    const candidate = yield* capture(BuildName.candidate("round-1"));
    yield* capture(BuildName.unfinished("round-1", 7));
    yield* capture(BuildName.turn("run_mzx1:step:12", 2));
    yield* capture(BuildName.ending("2026-11-05T12:00:00.000Z"));
    yield* capture(BuildName.restoreBefore("8c1f-uuid"));
    yield* capture(BuildName.stage("plan"));
    yield* capture(BuildName.proto(1));
    const keep = buildStep(
      { game, checkpoints, lock },
      { root, runId, lane: "godot" },
      { _tag: "keep", names: [BuildName.best, BuildName.kept("round-1")], sha: candidate },
    );
    // A keep the folder of the round's other builds would refuse, and its repeat.
    assert.isTrue((yield* keep).build.ok);
    assert.isTrue((yield* keep).build.ok);
    for (const name of [BuildName.best, BuildName.kept("round-1")])
      assert.equal(git("rev-parse", checkpointRefForGameRun(runId, name)), candidate);
    NodeFS.rmSync(root, { recursive: true, force: true });
  }).pipe(Effect.provide(layer)),
);

it.effect("clears a finished run's spent builds and keeps every one it or a person may need", () =>
  Effect.gen(function* () {
    const { root, git } = repo();
    const checkpoints = yield* CheckpointStore.CheckpointStore;
    const runId = "run_mzx1";
    const ref = (name: string) => checkpointRefForGameRun(runId, name);
    // A build under a name, at a commit time of its own.
    const build = (name: string, at: number, oid?: string) => {
      const made =
        oid ??
        NodeChildProcess.execFileSync("git", ["commit-tree", "HEAD^{tree}", "-m", name], {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_COMMITTER_DATE: `@${1_700_000_000 + at} +0000`,
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@t",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@t",
          },
        }).trim();
      git("update-ref", ref(name), made);
      return made;
    };
    const best = build(BuildName.best, 100);
    const pending = build(BuildName.candidate("round-3"), 300);
    const kept = [
      BuildName.base,
      BuildName.best,
      BuildName.kept("round-1"),
      BuildName.stage("plan"),
      BuildName.restoreBefore("r1"),
      BuildName.candidate("round-2"),
      BuildName.candidate("round-3"),
      // Every build the run log names as kept: each left round's work, each
      // ending's, a never-recorded round's candidate, a failed-checks round's.
      BuildName.unfinished("round-3", 9),
      BuildName.unfinished("round-2", 4),
      BuildName.ending("2026-11-05T12:00:00.000Z"),
      BuildName.ending("2026-11-04T12:00:00.000Z"),
      BuildName.candidate("round-4"),
      BuildName.candidate("round-6"),
      BuildName.turn("step:7", 1),
    ];
    // A turn whose build is the best is still the best.
    build(BuildName.turn("step:7", 1), 200, best);
    for (const [i, name] of kept.slice(2, -1).entries())
      if (name !== BuildName.candidate("round-3")) build(name, 210 + i);
    build(BuildName.base, 50);
    const spent = [
      BuildName.turn("step:5", 1),
      BuildName.turn("step:5", 2),
      BuildName.candidate("round-1"),
      // Beaten in both orders: the log never promised it.
      BuildName.candidate("round-5"),
    ];
    for (const name of spent) build(name, 150);
    const state = {
      ...freshState(
        {
          runId,
          profile: "guided",
          brief: "",
          artDirection: "",
          budgetMinutes: null,
          provider: null,
          model: null,
          variant: null,
          startedAt: "",
        },
        {
          rounds: [
            {
              round: 1,
              move: "",
              branch: "round-1",
              verdicts: [],
              kept: true,
              durationMs: 0,
              linesChanged: 0,
              build: "a".repeat(40),
            },
            {
              round: 2,
              move: "",
              branch: "round-2",
              verdicts: [],
              kept: false,
              unjudged: true,
              durationMs: 0,
              linesChanged: 0,
            },
            {
              round: 5,
              move: "",
              branch: "round-5",
              verdicts: [
                { order: "A=candidate,B=best", verdict: "B", reason: "" },
                { order: "A=best,B=candidate", verdict: "A", reason: "" },
              ],
              kept: false,
              durationMs: 0,
              linesChanged: 0,
            },
            {
              round: 6,
              move: "",
              branch: "round-6",
              verdicts: [],
              kept: false,
              note: "rung checks failed (1 FAIL); not judged",
              durationMs: 0,
              linesChanged: 0,
            },
          ],
          pending: { branch: "round-3", sha: pending, round: 3, verdicts: [], streak: 0 },
        },
      ),
      best,
    };
    expect(yield* pruneBuilds(checkpoints, root, state)).toBe(spent.length);
    const left = git("for-each-ref", "--format=%(refname)", checkpointRefForGameRun(runId, ""))
      .split("\n")
      .toSorted();
    expect(left).toEqual(kept.map(ref).toSorted());
    // A repeat, as a restarted finish runs it, finds nothing more to clear.
    expect(yield* pruneBuilds(checkpoints, root, state)).toBe(0);
    NodeFS.rmSync(root, { recursive: true, force: true });
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a budget leave's work is still there, under the name the log gave, after the finish prunes",
  () =>
    Effect.gen(function* () {
      const { root, git } = repo();
      const checkpoints = yield* CheckpointStore.CheckpointStore;
      const runId = "run_leave";
      const deps = { game, checkpoints, lock };
      const ctx = { root, runId, lane: "godot" };
      const best = yield* captureBuild(deps, root, runId, BuildName.best);
      // Round 3's candidate, built and tested; the budget is spent before judging.
      NodeFS.writeFileSync(NodePath.join(root, "godot", "main.gd"), "extends Node2D\n");
      const candidate = yield* captureBuild(deps, root, runId, BuildName.candidate("round-3"));
      const input = { now: 0, coin: 0.5, id: "x" };
      const fresh = freshState(
        {
          runId,
          profile: "autopilot",
          brief: "",
          artDirection: "",
          budgetMinutes: 60,
          provider: null,
          model: null,
          variant: null,
          startedAt: "",
        },
        {
          rounds: [
            {
              round: 1,
              move: "",
              branch: "round-1",
              verdicts: [],
              kept: true,
              durationMs: 0,
              linesChanged: 0,
            },
            {
              round: 2,
              move: "",
              branch: "round-2",
              verdicts: [],
              kept: true,
              durationMs: 0,
              linesChanged: 0,
            },
          ],
          pending: null,
        },
      );
      const round = Policy.reopen(fresh, 0).task;
      if (round._tag !== "round") throw new Error("expected a round");
      let state: RunState = {
        ...fresh,
        lane: "godot",
        best,
        seq: 11,
        budgetEndsAt: input.now,
        task: { ...round, phase: "restore", branch: "round-3", candidate },
      };
      const logs: string[] = [];
      while (state.ending === null) {
        const planned = Policy.plan(state, input);
        if (planned.kind !== "step" || planned.step.kind !== "build")
          throw new Error("expected a build");
        const result = yield* buildStep(deps, ctx, planned.step.op);
        const applied = Policy.applyResult(planned.state, planned.step, result, input);
        logs.push(...applied.logs);
        state = applied.state;
      }
      expect(state.ending).toBe("budget");
      // The next round reuses the left round's label; its candidate is not that work's name.
      expect(state.task).toMatchObject({ _tag: "round", n: 3 });
      const named = /kept as build (\S+)/.exec(logs.join("\n"))?.[1];
      expect(named).toBe(BuildName.unfinished("round-3", 13));
      yield* pruneBuilds(checkpoints, root, state);
      const kept = git("rev-parse", checkpointRefForGameRun(runId, named!));
      expect(git("show", `${kept}:godot/main.gd`)).toBe("extends Node2D");
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(layer)),
);

it.effect("restores a saved build by its name, keeps the folder before, and leaves the best", () =>
  Effect.gen(function* () {
    const { root, git } = repo();
    const checkpoints = yield* CheckpointStore.CheckpointStore;
    const runId = "run_saved";
    const write = (text: string) =>
      NodeFS.writeFileSync(NodePath.join(root, "godot", "main.gd"), text);
    const capture = (name: string) => captureBuild({ checkpoints, lock }, root, runId, name);
    write("best\n");
    const best = yield* capture(BuildName.best);
    const endedAt = "2026-11-05T12:00:00.000Z";
    write("left at the stop\n");
    const left = yield* capture(BuildName.ending(endedAt));
    write("edited since\n");
    const state: RunState = {
      ...freshState(
        {
          runId,
          profile: "guided",
          brief: "",
          artDirection: "",
          budgetMinutes: null,
          provider: null,
          model: null,
          variant: null,
          startedAt: "",
        },
        { rounds: [], pending: null },
      ),
      best,
    };
    // The run as its pending restore holds it; the job reads only these.
    const runFor = (requestId: string, build: string, undoes: string | null) =>
      ({
        id: runId,
        lane: "godot",
        ending: "stopped",
        endedAt,
        restore: {
          requestId,
          round: null,
          build,
          requestedAt: endedAt,
          outcome: null,
          replaced: null,
          undoes:
            undoes === null ? null : { best: undoes, pending: null, rounds: 0, abandoned: null },
        },
      }) as unknown as GameRun;
    const restore = (requestId: string, name: string, undoes: string | null = null) =>
      restoreBuild({
        game,
        checkpoints,
        lock,
        root,
        run: runFor(requestId, name, undoes),
        state,
        target: { kind: "saved", name },
        requestId,
      });
    const read = () => NodeFS.readFileSync(NodePath.join(root, "godot", "main.gd"), "utf8");
    const at = (name: string) => git("rev-parse", checkpointRefForGameRun(runId, name));

    const back = yield* restore("r1", BuildName.ending(endedAt));
    expect(back).toMatchObject({ kind: "restored", sha: left });
    expect(back.message).toContain("The game before restoring a saved build");
    expect(read()).toBe("left at the stop\n");
    // The creator's edit is a saved build of its own, and the run's best never moved.
    expect(git("show", `${at(BuildName.restoreBefore("r1"))}:godot/main.gd`)).toBe("edited since");
    expect(at(BuildName.best)).toBe(best);

    // Restoring the folder before undoes the restore; an undo moves the best's name to the best it puts back.
    const undone = yield* restore("r2", BuildName.restoreBefore("r1"), left);
    expect(undone.kind).toBe("restored");
    expect(undone.kind === "restored" ? undone.message : "").toContain("undoes the latest restore");
    expect(read()).toBe("edited since\n");
    expect(at(BuildName.best)).toBe(left);

    // A saved build the folder already holds moves nothing, so it is refused and keeps no "before".
    const same = yield* restore("r4", BuildName.restoreBefore("r1"));
    expect(same).toMatchObject({ kind: "refused", reason: "already-current" });
    expect(() => at(BuildName.restoreBefore("r4"))).toThrow();

    // A name the run never kept is refused, and the folder stays as it is.
    const gone = yield* restore("r3", BuildName.unfinished("round-9", 1));
    expect(gone).toMatchObject({ kind: "refused", reason: "commit-missing" });
    expect(read()).toBe("edited since\n");
    NodeFS.rmSync(root, { recursive: true, force: true });
  }).pipe(Effect.provide(layer)),
);
