// @effect-diagnostics nodeBuiltinImport:off -- A real repository on disk is what the run's builds live in.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { checkpointRefForGameRun } from "../../checkpointing/Utils.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import type * as GameService from "../GameService.ts";
import { BuildName } from "./buildNames.ts";
import { buildStep, captureBuild, pruneBuilds } from "./builds.ts";
import { freshState } from "./state.ts";

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

it.effect("keeps a round beside its candidate, under names git can store, again and again", () =>
  Effect.gen(function* () {
    const { root, git } = repo();
    const checkpoints = yield* CheckpointStore.CheckpointStore;
    const runId = "run_mzx1:a";
    const capture = (name: string) => captureBuild(checkpoints, root, runId, name);
    // Every kind of name the run makes, as real ids and times give them.
    const candidate = yield* capture(BuildName.candidate("round-1"));
    yield* capture(BuildName.unfinished("round-1"));
    yield* capture(BuildName.turn("run_mzx1:step:12", 2));
    yield* capture(BuildName.ending("2026-11-05T12:00:00.000Z"));
    yield* capture(BuildName.restoreBefore("8c1f-uuid"));
    yield* capture(BuildName.stage("plan"));
    yield* capture(BuildName.proto(1));
    const keep = buildStep(
      { game, checkpoints },
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
      BuildName.unfinished("round-3"),
      BuildName.ending("2026-11-05T12:00:00.000Z"),
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
      BuildName.unfinished("round-2"),
      BuildName.ending("2026-11-04T12:00:00.000Z"),
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
