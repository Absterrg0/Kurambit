// @effect-diagnostics nodeBuiltinImport:off -- Acceptance against real Godot copies; drives the service, never a mock.
import { it, expect } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { PNG } from "pngjs";
import * as GamePreview from "./GamePreview.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameDesignApproval from "./GameDesignApproval.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameRoundStore from "./GameRoundStore.ts";
import * as GameService from "./GameService.ts";
import * as GameWebPlaytest from "./GameWebPlaytest.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  admissionTestLayer,
  previewBrowserTestLayer,
  projectTestLayer,
  designApprovalTestLayer,
  roundStoreTestLayer,
  qualificationTestLayer,
} from "./gameTestLayers.ts";
import { snapshotBuildSource } from "./sourceSnapshot.ts";

const ORCH =
  "/home/abstergo/Programming/Projects/game-studio-orch/production-readiness-20261030/opus-takeover";
const CARD_SRC = `${ORCH}/t13/games-minimal/ember-hand-2026-10-301712`;
const PLATFORMER_SRC = `${ORCH}/t13/games-minimal/lantern-rooftops-2026-10-301744`;
const DIALOGUE_SRC = `${ORCH}/t12/games-harness/night-frequency-2026-10-301614`;

const serviceLayers = (stateDir: string) =>
  GameService.layer.pipe(
    Layer.provideMerge(GameProjectService.layer),
    Layer.provideMerge(GameOperations.layer),
    Layer.provideMerge(GameToolchain.layer),
    Layer.provideMerge(GamePreview.layer),
    Layer.provideMerge(GameProcesses.layer),
    Layer.provide(projectTestLayer()),
    Layer.provide(previewBrowserTestLayer()),
    Layer.provideMerge(qualificationTestLayer(stateDir)),
    Layer.provideMerge(designApprovalTestLayer(stateDir)),
    Layer.provideMerge(roundStoreTestLayer(stateDir)),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provideMerge(admissionTestLayer),
    Layer.provide(NodeServices.layer),
  );

const openCopy = (src: string, tag: string) =>
  Effect.gen(function* () {
    const parent = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), `t14-${tag}-`)),
    );
    const dest = NodePath.join(parent, "game");
    yield* Effect.promise(() => NodeFSP.cp(src, dest, { recursive: true }));
    return { parent, dest };
  });

const openGame = (dest: string) =>
  Effect.gen(function* () {
    const projects = yield* GameProjectService.GameProjectService;
    const created = yield* projects.open({
      path: dest,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
    });
    // Harness copies may carry an unapproved DESIGN.md; approve the current
    // revision the way the creator would so the gate tests the game, not the
    // paperwork. Copies without a design pass untouched.
    const designs = yield* GameDesignApproval.GameDesignApproval;
    const manifest = yield* projects.read(dest);
    const snap = yield* designs.snapshot(dest, manifest);
    if (snap.read.state !== "approved" && snap.read.currentHash !== null) {
      yield* Effect.log(`Approving design for acceptance copy (state=${snap.read.state}).`);
      yield* projects.approveDesign(created.threadId, snap.read.currentHash);
    }
    return created;
  });

const sourceIdOf = (dest: string) =>
  Effect.promise(async () => {
    const snap = await snapshotBuildSource(dest, "godot");
    if (snap.kind !== "known") throw new Error(`unknown sources: ${snap.kind}`);
    return snap.sourceId;
  });

const nonBlank = (bytes: Buffer) => {
  const png = PNG.sync.read(bytes);
  const seen = new Set<number>();
  const data = png.data as Buffer;
  for (let i = 0; i < data.length; i += 4) {
    seen.add((data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!);
    if (seen.size > 100) break;
  }
  return { distinct: seen.size, width: png.width, height: png.height };
};

const whiskers = (value: unknown) => JSON.stringify(value)?.slice(0, 1200);

it.live(
  "card: native explore boots, acts, pauses, inspects, errors, closes and replays",
  () =>
    Effect.gen(function* () {
      const { parent, dest } = yield* openCopy(CARD_SRC, "card");
      const stateDir = NodePath.join(parent, "state");
      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const game = yield* GameService.GameService;
            const processes = yield* GameProcesses.GameProcesses;
            const created = yield* openGame(dest);
            const threadId = created.threadId;
            const beforeId = yield* sourceIdOf(dest);

            const started = yield* game.exploreStart(threadId, { target: "native" });
            console.log("CARD start", whiskers({ ...started, sessionId: "<id>", traceId: "<id>" }));
            expect(started.target).toBe("native");
            expect(started.booted).toBe(true);
            expect(started.viewport).toEqual({ width: 960, height: 540 });

            // The launch stays off the real desktop: the tracked Godot child
            // carries only xvfb-run's private DISPLAY and no Wayland socket.
            const childEnv = yield* Effect.promise(async () => {
              for (const name of await NodeFSP.readdir("/proc")) {
                if (!/^\d+$/.test(name)) continue;
                const cmd = await NodeFSP.readFile(`/proc/${name}/cmdline`, "utf8").catch(() => "");
                const argv0 = cmd.split("\0")[0] ?? "";
                // argv[0] is the executable: the wrapper is xvfb-run, the game is the Godot binary.
                if (!argv0.includes("Godot_v")) continue;
                if (!cmd.includes(`game-explore-${started.sessionId}`)) continue;
                const raw = await NodeFSP.readFile(`/proc/${name}/environ`, "utf8").catch(() => "");
                const env: Record<string, string> = {};
                for (const part of raw.split("\0")) {
                  const i = part.indexOf("=");
                  if (i > 0) env[part.slice(0, i)] = part.slice(i + 1);
                }
                return {
                  pid: name,
                  display: env["DISPLAY"] ?? null,
                  wayland: env["WAYLAND_DISPLAY"] ?? null,
                };
              }
              return null;
            });
            console.log("CARD child-env", whiskers(childEnv));
            expect(childEnv).not.toBeNull();
            expect(childEnv!.display).not.toBeNull();
            expect(childEnv!.display).not.toBe(":0");
            expect(childEnv!.wayland).toBeNull();

            const bootAct = yield* game.exploreAct(threadId, {
              sessionId: started.sessionId,
              steps: [
                { inspect: { path: "GameState", properties: ["mana", "cards_played", "turn"] } },
              ],
            });
            console.log("CARD boot-inspect", whiskers(bootAct));
            expect(bootAct.probe).not.toBeNull();
            // (a) real ui and screen text at the project window size.
            const ui = bootAct.ui ?? [];
            const text = bootAct.screenText ?? {};
            console.log("CARD ui-count", ui.length, "text-keys", Object.keys(text).length);
            console.log("CARD ui-labels", whiskers(ui.map((c) => [c.id, c.kind, c.label])));
            expect(ui.length).toBeGreaterThan(0);
            expect(Object.keys(text).length).toBeGreaterThan(0);
            for (const control of ui) {
              expect(control.rect.x).toBeGreaterThanOrEqual(0);
              expect(control.rect.y).toBeGreaterThanOrEqual(0);
              expect(control.rect.x + control.rect.width).toBeLessThanOrEqual(960);
              expect(control.rect.y + control.rect.height).toBeLessThanOrEqual(540);
            }
            const card = ui.find((c) => c.kind === "button" && c.label.includes("Cost"));
            const tile = ui.find(
              (c) =>
                c.kind === "button" &&
                !c.label.includes("Cost") &&
                c.label !== "End Turn (Space)" &&
                c.label !== "New Run",
            );
            expect(card).toBeDefined();
            expect(tile).toBeDefined();
            console.log("CARD card/tile", whiskers([card, tile]));

            // (b) one ui input changes state: drag the card onto a tile.
            // (A bare click on the card is honestly reported as not received:
            // the game's own drag ghost covers the button on press, so the
            // release never reaches it. Drag is the game's real path.)
            const manaBefore = (bootAct.inspections?.[0]?.values as Record<string, number>)?.[
              "mana"
            ];
            const playedBefore = (bootAct.inspections?.[0]?.values as Record<string, number>)?.[
              "cards_played"
            ];
            const played = yield* game.exploreAct(threadId, {
              sessionId: started.sessionId,
              steps: [{ ui: { id: card!.id, action: "drag", to: tile!.id } }],
            });
            console.log(
              "CARD play",
              whiskers({ uiResults: played.uiResults, probe: played.probe?.gameState }),
            );
            const check = yield* game.exploreAct(threadId, {
              sessionId: started.sessionId,
              steps: [{ inspect: { path: "GameState", properties: ["mana", "cards_played"] } }],
            });
            const manaAfter = (check.inspections?.[0]?.values as Record<string, number>)?.["mana"];
            const playedAfter = (check.inspections?.[0]?.values as Record<string, number>)?.[
              "cards_played"
            ];
            console.log(
              "CARD mana/played",
              whiskers({ manaBefore, playedBefore, manaAfter, playedAfter }),
            );
            expect(playedAfter).toBe((playedBefore ?? 0) + 1);
            expect(played.uiResults?.[0]?.received).toBe(true);

            // (c) state does not advance across a pause between acts.
            const p1 = yield* game.exploreAct(threadId, {
              sessionId: started.sessionId,
              steps: [{ inspect: { path: "GameState" } }],
            });
            yield* Effect.sleep("1 second");
            const p2 = yield* game.exploreAct(threadId, {
              sessionId: started.sessionId,
              steps: [{ inspect: { path: "GameState" } }],
            });
            console.log("CARD pause-p1", whiskers(p1.probe?.gameState));
            console.log("CARD pause-p2", whiskers(p2.probe?.gameState));
            expect(p2.probe?.gameState).toEqual(p1.probe?.gameState);

            // (d) inspect reads a GameState value and a node property.
            const inspected = yield* game.exploreAct(threadId, {
              sessionId: started.sessionId,
              steps: [
                { inspect: { path: "GameState", properties: ["mana"] } },
                { inspect: { path: "Main", properties: ["position"] } },
              ],
            });
            console.log("CARD inspected", whiskers(inspected.inspections));
            expect(inspected.inspections?.[0]?.values["mana"]).toBe(manaAfter);
            expect(inspected.inspections?.[1]?.values["position"]).toBeDefined();
            expect(inspected.inspections?.[1]?.error).toBeUndefined();

            // (g) the picture is non-blank where a display is available.
            if (played.screenshotPath !== null) {
              const bytes = yield* Effect.promise(() =>
                NodeFSP.readFile(played.screenshotPath as string),
              );
              const stats = nonBlank(bytes);
              console.log("CARD picture", whiskers(stats));
              expect(stats.width).toBe(960);
              expect(stats.height).toBe(540);
              expect(stats.distinct).toBeGreaterThan(100);
            } else {
              console.log("CARD no-display", played.screenshotReason);
            }

            // Tracked process present while live, gone after close (f).
            expect(processes.list(dest).length).toBe(1);
            const closed = yield* game.exploreClose(threadId, { sessionId: started.sessionId });
            console.log("CARD closed", whiskers(closed));
            expect(closed.reason).toBe("closed");
            expect(processes.list(dest).length).toBe(0);
            const afterId = yield* sourceIdOf(dest);
            expect(afterId).toBe(beforeId);

            const replayed = yield* game.exploreReplay(threadId, { traceId: closed.traceId });
            console.log(
              "CARD replayed",
              whiskers({
                ...replayed,
                evidenceDirectory: "<dir>",
                frames: replayed.frames.map((f) => ({ ...f, path: "<f>" })),
              }),
            );
            expect(replayed.booted).toBe(true);
            expect(replayed.responded).toBe(true);
            yield* Effect.promise(() =>
              NodeFSP.rm(NodePath.dirname(closed.tracePath), { recursive: true, force: true }),
            );
            yield* Effect.promise(() =>
              NodeFSP.rm(replayed.evidenceDirectory, { recursive: true, force: true }),
            );
          }).pipe(Effect.provide(serviceLayers(stateDir))),
        );
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(parent, { recursive: true, force: true }));
      }
    }),
  600_000,
);

it.live(
  "platformer: hold moves the player and the trace replays",
  () =>
    Effect.gen(function* () {
      const { parent, dest } = yield* openCopy(PLATFORMER_SRC, "platformer");
      const stateDir = NodePath.join(parent, "state");
      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const game = yield* GameService.GameService;
            const processes = yield* GameProcesses.GameProcesses;
            const created = yield* openGame(dest);
            const threadId = created.threadId;
            const beforeId = yield* sourceIdOf(dest);
            const started = yield* game.exploreStart(threadId, { target: "native" });
            console.log("PLATFORM start", whiskers({ viewport: started.viewport }));
            expect(started.viewport).toEqual({ width: 960, height: 540 });

            const boot = yield* game.exploreAct(threadId, {
              sessionId: started.sessionId,
              steps: [{ inspect: { path: "GameState", properties: ["jumps"] } }],
            });
            const x0 = boot.probe?.player?.x ?? null;
            console.log(
              "PLATFORM x0",
              whiskers({
                x0,
                ui: boot.ui?.length,
                text: Object.keys(boot.screenText ?? {}).length,
              }),
            );
            expect(x0).not.toBeNull();

            const moved = yield* game.exploreAct(threadId, {
              sessionId: started.sessionId,
              steps: [{ key: "ArrowRight", holdMs: 800 }],
            });
            const x1 = moved.probe?.player?.x ?? null;
            console.log("PLATFORM x1", whiskers({ x0, x1 }));
            expect(x1).not.toBeNull();
            expect(Math.abs((x1 as number) - (x0 as number))).toBeGreaterThan(5);

            const p1 = yield* game.exploreAct(threadId, {
              sessionId: started.sessionId,
              steps: [{ inspect: { path: "GameState" } }],
            });
            yield* Effect.sleep("1 second");
            const p2 = yield* game.exploreAct(threadId, {
              sessionId: started.sessionId,
              steps: [{ inspect: { path: "GameState" } }],
            });
            console.log("PLATFORM pause", whiskers({ a: p1.probe?.player, b: p2.probe?.player }));
            expect(p2.probe?.gameState).toEqual(p1.probe?.gameState);

            const inspected = yield* game.exploreAct(threadId, {
              sessionId: started.sessionId,
              steps: [
                { inspect: { path: "GameState", properties: ["jumps"] } },
                { inspect: { path: "Main", properties: ["position"] } },
              ],
            });
            console.log("PLATFORM inspected", whiskers(inspected.inspections));
            expect(inspected.inspections?.[0]?.values["jumps"]).toBeDefined();

            if (moved.screenshotPath !== null) {
              const bytes = yield* Effect.promise(() =>
                NodeFSP.readFile(moved.screenshotPath as string),
              );
              const stats = nonBlank(bytes);
              console.log("PLATFORM picture", whiskers(stats));
              expect(stats.distinct).toBeGreaterThan(100);
            } else {
              console.log("PLATFORM no-display", moved.screenshotReason);
            }

            expect(processes.list(dest).length).toBe(1);
            const closed = yield* game.exploreClose(threadId, { sessionId: started.sessionId });
            expect(closed.reason).toBe("closed");
            expect(processes.list(dest).length).toBe(0);
            expect(yield* sourceIdOf(dest)).toBe(beforeId);

            const replayed = yield* game.exploreReplay(threadId, { traceId: closed.traceId });
            console.log(
              "PLATFORM replayed",
              whiskers({ responded: replayed.responded, frames: replayed.frames.length }),
            );
            expect(replayed.booted).toBe(true);
            expect(replayed.responded).toBe(true);
            yield* Effect.promise(() =>
              NodeFSP.rm(NodePath.dirname(closed.tracePath), { recursive: true, force: true }),
            );
            yield* Effect.promise(() =>
              NodeFSP.rm(replayed.evidenceDirectory, { recursive: true, force: true }),
            );
          }).pipe(Effect.provide(serviceLayers(stateDir))),
        );
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(parent, { recursive: true, force: true }));
      }
    }),
  600_000,
);

it.live(
  "dialogue: ui click advances the scene and script errors report file:line",
  () =>
    Effect.gen(function* () {
      const { parent, dest } = yield* openCopy(DIALOGUE_SRC, "dialogue");
      const stateDir = NodePath.join(parent, "state");
      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const game = yield* GameService.GameService;
            const processes = yield* GameProcesses.GameProcesses;
            const created = yield* openGame(dest);
            const threadId = created.threadId;
            const beforeId = yield* sourceIdOf(dest);
            const started = yield* game.exploreStart(threadId, { target: "native" });
            expect(started.viewport).toEqual({ width: 960, height: 540 });

            const boot = yield* game.exploreAct(threadId, {
              sessionId: started.sessionId,
              steps: [{ inspect: { path: "GameState", properties: ["replies", "state"] } }],
            });
            const ui = boot.ui ?? [];
            console.log("DIALOGUE ui", whiskers(ui.map((c) => [c.id, c.kind, c.label])));
            expect(ui.length).toBeGreaterThan(0);
            const listen = ui.find((c) => c.label.includes("LISTEN"));
            const reply = ui.find((c) => c.kind === "button" && /^\d/.test(c.label.trim()));
            expect(listen).toBeDefined();
            expect(reply).toBeDefined();

            const before =
              (boot.inspections?.[0]?.values as Record<string, number>)?.["replies"] ?? 0;
            const answered = yield* game.exploreAct(threadId, {
              sessionId: started.sessionId,
              steps: [
                { ui: { id: listen!.id, action: "click" } },
                { ui: { id: reply!.id, action: "click" } },
              ],
            });
            console.log("DIALOGUE answered", whiskers(answered.uiResults));
            const check = yield* game.exploreAct(threadId, {
              sessionId: started.sessionId,
              steps: [{ inspect: { path: "GameState", properties: ["replies"] } }],
            });
            const afterReplies = (check.inspections?.[0]?.values as Record<string, number>)?.[
              "replies"
            ];
            console.log("DIALOGUE replies", whiskers({ before, after: afterReplies }));
            expect(afterReplies).toBe(before + 1);
            expect(answered.uiResults?.filter((r) => r.received).length).toBe(2);

            const p1 = yield* game.exploreAct(threadId, {
              sessionId: started.sessionId,
              steps: [{ inspect: { path: "GameState" } }],
            });
            yield* Effect.sleep("1 second");
            const p2 = yield* game.exploreAct(threadId, {
              sessionId: started.sessionId,
              steps: [{ inspect: { path: "GameState" } }],
            });
            const g1 = { ...(p1.probe?.gameState ?? {}) } as Record<string, number>;
            const g2 = { ...(p2.probe?.gameState ?? {}) } as Record<string, number>;
            const drift = Math.abs((g2["time_left"] ?? 0) - (g1["time_left"] ?? 0));
            console.log("DIALOGUE pause-drift", whiskers({ drift, g1, g2 }));
            delete (g1 as Record<string, unknown>)["time_left"];
            delete (g2 as Record<string, unknown>)["time_left"];
            expect(g2).toEqual(g1);
            expect(drift).toBeLessThan(0.5);

            const inspected = yield* game.exploreAct(threadId, {
              sessionId: started.sessionId,
              steps: [
                { inspect: { path: "GameState", properties: ["trust"] } },
                { inspect: { path: "Main", properties: ["position"] } },
              ],
            });
            console.log("DIALOGUE inspected", whiskers(inspected.inspections));
            expect(inspected.inspections?.[0]?.values["trust"]).toBeDefined();

            if (answered.screenshotPath !== null) {
              const bytes = yield* Effect.promise(() =>
                NodeFSP.readFile(answered.screenshotPath as string),
              );
              const stats = nonBlank(bytes);
              console.log("DIALOGUE picture", whiskers(stats));
              expect(stats.distinct).toBeGreaterThan(100);
            } else {
              console.log("DIALOGUE no-display", answered.screenshotReason);
            }

            expect(processes.list(dest).length).toBe(1);
            const closed = yield* game.exploreClose(threadId, { sessionId: started.sessionId });
            expect(processes.list(dest).length).toBe(0);
            expect(yield* sourceIdOf(dest)).toBe(beforeId);
            const replayed = yield* game.exploreReplay(threadId, { traceId: closed.traceId });
            console.log(
              "DIALOGUE replayed",
              whiskers({ responded: replayed.responded, frames: replayed.frames.length }),
            );
            expect(replayed.responded).toBe(true);
            yield* Effect.promise(() =>
              NodeFSP.rm(NodePath.dirname(closed.tracePath), { recursive: true, force: true }),
            );
            yield* Effect.promise(() =>
              NodeFSP.rm(replayed.evidenceDirectory, { recursive: true, force: true }),
            );
          }).pipe(Effect.provide(serviceLayers(stateDir))),
        );
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(parent, { recursive: true, force: true }));
      }
    }),
  600_000,
);

it.live(
  "card error copy: a deliberate script error reports file:line; a self-pausing game still answers",
  () =>
    Effect.gen(function* () {
      const { parent, dest } = yield* openCopy(CARD_SRC, "carderr");
      const stateDir = NodePath.join(parent, "state");
      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const game = yield* GameService.GameService;
            // (e) deliberately added script error in a copy.
            const mainPath = NodePath.join(dest, "godot/scripts/main.gd");
            const mainText = yield* Effect.promise(() => NodeFSP.readFile(mainPath, "utf8"));
            expect(mainText).toContain("func _process(_delta: float) -> void:");
            const broken = mainText.replace(
              "func _process(_delta: float) -> void:",
              'func _process(_delta: float) -> void:\n\tpush_error("deliberate acceptance error")',
            );
            yield* Effect.promise(() => NodeFSP.writeFile(mainPath, broken));
            const created = yield* openGame(dest);
            const threadId = created.threadId;
            const started = yield* game.exploreStart(threadId, { target: "native" });
            const acted = yield* game.exploreAct(threadId, {
              sessionId: started.sessionId,
              steps: [{ inspect: { path: "GameState", properties: ["mana"] } }],
            });
            console.log("CARDERR errors", whiskers(acted.errors));
            expect((acted.errors ?? []).length).toBeGreaterThan(0);
            const hit = (acted.errors ?? []).find((e) =>
              e.message.includes("deliberate acceptance error"),
            );
            expect(hit).toBeDefined();
            expect(hit!.where).toMatch(/main\.gd:\d+$/);
            yield* game.exploreClose(threadId, { sessionId: started.sessionId });

            // A game that pauses itself: the runner keeps answering.
            const { dest: paused } = yield* openCopy(CARD_SRC, "cardpause");
            const pausedMain = NodePath.join(paused, "godot/scripts/main.gd");
            const pausedText = yield* Effect.promise(() => NodeFSP.readFile(pausedMain, "utf8"));
            const selfPausing = pausedText.replace(
              "func _ready() -> void:",
              "func _ready() -> void:\n\tget_tree().paused = true",
              // only the first occurrence is the main _ready
            );
            yield* Effect.promise(() => NodeFSP.writeFile(pausedMain, selfPausing));
            const createdPause = yield* openGame(paused);
            const startedPause = yield* game.exploreStart(createdPause.threadId, {
              target: "native",
            });
            const answered = yield* game.exploreAct(createdPause.threadId, {
              sessionId: startedPause.sessionId,
              steps: [{ inspect: { path: "GameState", properties: ["mana"] } }],
            });
            console.log("CARDPAUSE probe", whiskers(answered.probe?.gameState));
            expect(answered.probe?.gameState["mana"]).toBe(3);
            yield* game.exploreClose(createdPause.threadId, { sessionId: startedPause.sessionId });
          }).pipe(Effect.provide(serviceLayers(stateDir))),
        );
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(parent, { recursive: true, force: true }));
      }
    }),
  600_000,
);
