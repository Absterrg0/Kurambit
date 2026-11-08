// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- Writes a scene report's frames beside its play's evidence, reads it back, and plays game_check's short random input in real time.
// The scene report, measured inside the running game by the three.js shell
// (templates/blank-three/web/shell/scene-report.js, which holds every threshold) while the
// harness plays it: game_check's short play and the facts' random-input play. What the page
// says is checked here before it becomes evidence, and its frames become files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  GameSceneEmpty,
  GameSceneFinding,
  GameScenePlayer,
  GameSceneReport,
  type GameEngineId,
} from "@kurambit/contracts";
import { engineProfile } from "./engineProfile.ts";

/** Beside a bot run's trace: its play's scene report, frames named relative to the run folder. */
export const SCENE_FILE = "scene.json";

/** Starts the shell's scene report; null when the page's shell has none (it predates them). */
export const START_SCENE = `(() => {
  const scene = window.__studio?.scene;
  if (scene === null || typeof scene !== "object" || typeof scene.start !== "function") return null;
  try {
    return scene.start() === true;
  } catch {
    return false;
  }
})()`;

/** Reads the shell's scene report as JSON; null when it has none or it throws. */
export const READ_SCENE = `(() => {
  const scene = window.__studio?.scene;
  if (scene === null || typeof scene !== "object" || typeof scene.read !== "function") return null;
  try {
    return JSON.stringify(scene.read());
  } catch {
    return null;
  }
})()`;

/** What a play's page left: its report, a shell with none, or a report that could not be read. */
export type PageScene = { readonly raw: unknown } | "no-shell" | null;

const PNG_DATA = "data:image/png;base64,";
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const FRAME_ID = /^scene-\d{1,2}$/;

/** The page's report: the contract's shape with frame ids, and the frames as PNG data URLs. */
const PageReport = Schema.Struct({
  version: Schema.Literal(1),
  seconds: Schema.Finite,
  findings: Schema.Array(GameSceneFinding).check(Schema.isMaxLength(24)),
  player: GameScenePlayer,
  unseen: Schema.Array(Schema.String).check(Schema.isMaxLength(16)),
  unseenMore: Schema.Finite,
  empty: Schema.optionalKey(GameSceneEmpty),
  cost: Schema.Struct({ meanMs: Schema.Finite, worstMs: Schema.Finite }),
  frames: Schema.Array(Schema.Struct({ id: Schema.String, png: Schema.String })).check(
    Schema.isMaxLength(8),
  ),
});
const decodePageReport = Schema.decodeUnknownOption(PageReport);
/** A run's kept record: the report, or a shell that has none. */
const SceneFile = Schema.fromJsonString(
  Schema.Union([Schema.Struct({ shell: Schema.Literal("none") }), GameSceneReport]),
);
const decodeSceneFile = Schema.decodeUnknownOption(SceneFile);
const writeSceneFile = Schema.encodeSync(SceneFile);

const clip = (text: string | null) => (text === null ? null : text.slice(0, 120));

/**
 * Writes the report's frames into `dir` (its own folder, checked by the caller) and returns
 * the report with each frame named `prefix` + its file name; a frame that does not decode or
 * write is dropped, never invented. Null when the page's report does not read as one.
 */
export const keepSceneReport = async (
  raw: unknown,
  dir: string,
  prefix: string,
): Promise<GameSceneReport | null> => {
  const decoded = decodePageReport(raw);
  if (Option.isNone(decoded)) return null;
  const page = decoded.value;
  const kept = new Map<string, string>();
  for (const frame of page.frames) {
    if (!FRAME_ID.test(frame.id) || !frame.png.startsWith(PNG_DATA)) continue;
    const bytes = Buffer.from(frame.png.slice(PNG_DATA.length), "base64");
    if (bytes.length === 0 || bytes.length > MAX_FRAME_BYTES) continue;
    const name = `${frame.id}.png`;
    const written = await NodeFSP.writeFile(NodePath.join(dir, name), bytes).then(
      () => true,
      () => false,
    );
    if (written) kept.set(frame.id, `${prefix}${name}`);
  }
  const frameOf = (id: string | null) => (id === null ? null : (kept.get(id) ?? null));
  const player = page.player;
  return {
    seconds: page.seconds,
    findings: page.findings.map((finding) => ({
      ...finding,
      thing: clip(finding.thing),
      other: clip(finding.other),
      frame: frameOf(finding.frame),
    })),
    player:
      player.kind === "body"
        ? {
            ...player,
            name: player.name.slice(0, 120),
            blocker: clip(player.blocker),
            frame: frameOf(player.frame),
            smallFrame: frameOf(player.smallFrame),
          }
        : player,
    unseen: page.unseen.map((name) => name.slice(0, 120)),
    unseenMore: Math.max(0, Math.round(page.unseenMore)),
    ...(page.empty === undefined
      ? {}
      : {
          empty: {
            ...page.empty,
            colour: page.empty.colour.slice(0, 16),
            frame: frameOf(page.empty.frame),
          },
        }),
    cost: page.cost,
  };
};

/** A bot run's scene record, as it is kept beside its trace. */
export const encodeSceneFile = (scene: GameSceneReport | "no-shell") =>
  `${writeSceneFile(scene === "no-shell" ? { shell: "none" } : scene)}\n`;

/**
 * A run's scene report, its frames named from the game root: "none" when the game's shell has
 * no scene report, null when the run left no readable record.
 */
export const readSceneFile = (
  root: string,
  evidence: string,
): Promise<GameSceneReport | "no-shell" | null> =>
  NodeFSP.readFile(NodePath.join(root, evidence, SCENE_FILE), "utf8").then(
    (text) => {
      const report = Option.getOrNull(decodeSceneFile(text));
      if (report === null) return null;
      if ("shell" in report) return "no-shell" as const;
      const from = (frame: string | null) => (frame === null ? null : `${evidence}/${frame}`);
      return {
        ...report,
        findings: report.findings.map((finding) => ({ ...finding, frame: from(finding.frame) })),
        player:
          report.player.kind === "body"
            ? {
                ...report.player,
                frame: from(report.player.frame),
                smallFrame: from(report.player.smallFrame),
              }
            : report.player,
        ...(report.empty === undefined
          ? {}
          : { empty: { ...report.empty, frame: from(report.empty.frame) } }),
      };
    },
    () => null,
  );

/** Why there is no scene report: the shell predates it, or the engine has none yet. */
export const SCENE_OLD_SHELL = "the game's shell predates scene reports";
export const sceneNotInEngine = (engine: GameEngineId) =>
  `${engineProfile(engine).displayName} games have no scene report yet; it is measured for three.js games`;

/** How long game_check plays the gameplay entry for its scene report. */
export const SCENE_CHECK_PLAY_MS = 6_000;

// The bot kit's masher verbs (templates/bot-kit/masher.mjs): every shell's movement and
// action keys, never Escape or P (pause).
const DIRECTIONS = [
  ["D", "ArrowRight"],
  ["A", "ArrowLeft"],
  ["W", "ArrowUp"],
  ["S", "ArrowDown"],
] as const;
const TAPS = ["Space", "Shift", "E", "Enter", "J", "K", "Z", "X"] as const;

/**
 * Random input for `ms`, seeded as the masher is so every check plays the same sequence:
 * a direction or two held for 0.3–0.8 s, often with an action key tapped. Keys are let go
 * at the end.
 */
export const playRandomly = async (
  input: (keys: {
    readonly held: readonly string[];
    readonly taps: readonly string[];
    readonly clicks: readonly [];
  }) => Promise<void>,
  ms: number,
  signal?: AbortSignal,
): Promise<void> => {
  let seed = 0x9e3779b9;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = seed;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <A>(list: ReadonlyArray<A>) => list[Math.floor(random() * list.length)]!;
  const until = Date.now() + ms;
  try {
    for (;;) {
      if (Date.now() >= until || signal?.aborted === true) break;
      const held = new Set<string>(pick(DIRECTIONS));
      if (random() < 0.4) for (const key of pick(DIRECTIONS)) held.add(key);
      const taps = random() < 0.6 ? [pick(TAPS)] : [];
      await input({ held: [...held], taps, clicks: [] });
      const wait = Math.min(300 + random() * 500, Math.max(0, until - Date.now()));
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  } finally {
    await input({ held: [], taps: [], clicks: [] });
  }
};
