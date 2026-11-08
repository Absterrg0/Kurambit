import {
  gameFactsView,
  type GameBuildFacts,
  type GameFactView,
} from "../../packages/contracts/src/index.ts";

/**
 * Bump when a score stops meaning what it meant (a criterion or threshold
 * changes): runs scored by another version are listed, never diffed.
 */
export const SCORE_VERSION = 2;

/**
 * Every number the score judges against. Change one here, never at a use site. What a person
 * sees (the player too small, the view empty) is judged by the game's shell, by the limits in
 * its scene report (templates/runtime/three/1/shell/scene-report.js); the score reads its verdicts.
 */
export const THRESHOLDS = {
  /**
   * A game that ends by itself (no input) or under random input sooner than this
   * ended before a person could read the screen: Fox Dash's buried first build
   * was lost in about a second.
   */
  instantEndSeconds: 5,
  /**
   * The median frame rate the random-input play must hold. Below 30 fps a person
   * feels the game stutter; the facts rail words it "bad" at the same line.
   */
  minFps: 30,
  /**
   * The product's promise is a playable game inside the first ten minutes, so a
   * brief's first booting build must land within that from the moment it was sent.
   */
  firstPlayableSeconds: 600,
} as const;

/** The criteria a game is scored on, in report order. */
export const CRITERIA = [
  "boots",
  "ending",
  "scene",
  "view",
  "performance",
  "first-playable",
] as const;
export type Criterion = (typeof CRITERIA)[number];

export const CRITERION_LABELS: Readonly<Record<Criterion, string>> = {
  boots: "Boots",
  ending: "Can be won or lost, not instantly",
  scene: "Player visible and big enough, nothing buried or clipping",
  view: "View filled, no void",
  performance: `Holds ${THRESHOLDS.minFps} fps`,
  "first-playable": `Playable within ${THRESHOLDS.firstPlayableSeconds / 60} min`,
};

export type Verdict =
  | { readonly result: "pass"; readonly detail: string }
  | { readonly result: "fail"; readonly detail: string }
  | { readonly result: "not-measured"; readonly detail: string };

export interface GameScore {
  readonly verdicts: Readonly<Record<Criterion, Verdict>>;
  readonly passed: number;
  readonly total: number;
}

/**
 * The facts that are not the scene's. Any other fact the server's view has is the
 * scene report's (player-visible, buried, clipping …), read without naming it, so a
 * new scene row is scored the moment it lands. The empty view is a criterion of its own.
 */
const FACTS_BEFORE_SCENE_REPORT: ReadonlySet<string> = new Set([
  "boots",
  "idle",
  "masher",
  "skilled",
  "winnable-without-skill",
  "freeze",
  "motion",
  "detail",
  "colour",
  "first-response",
  "performance",
  "assets",
  "use",
  "empty",
]);

export const sceneFacts = (views: ReadonlyArray<GameFactView>) =>
  views.filter((view) => !FACTS_BEFORE_SCENE_REPORT.has(view.id));

const pass = (detail: string): Verdict => ({ result: "pass", detail });
const fail = (detail: string): Verdict => ({ result: "fail", detail });
const notMeasured = (detail: string): Verdict => ({ result: "not-measured", detail });

type Tier = GameBuildFacts["idle"];

const bootsVerdict = (facts: GameBuildFacts): Verdict =>
  facts.boots.status === "measured"
    ? facts.boots.value.ok
      ? pass("boot check clean")
      : fail(facts.boots.value.detail)
    : notMeasured(facts.boots.status === "pending" ? "still measuring" : facts.boots.why);

const endingVerdict = (facts: GameBuildFacts): Verdict => {
  const tiers: ReadonlyArray<readonly [string, Tier]> = [
    ["no input", facts.idle],
    ["random input", facts.masher],
    ["tester's bot", facts.skilled],
  ];
  const measured = tiers.flatMap(([who, tier]) =>
    tier.status === "measured" ? [{ who, tier: tier.value }] : [],
  );
  if (measured.length === 0) return notMeasured("no play tier was measured");
  // Only the two plays with no skill can show a game ending by itself.
  const instant = measured.find(
    ({ who, tier }) =>
      who !== "tester's bot" &&
      (tier.ending === "won" || tier.ending === "lost") &&
      tier.at !== null &&
      tier.at < THRESHOLDS.instantEndSeconds,
  );
  if (instant)
    return fail(`${instant.who} ${instant.tier.ending} at ${instant.tier.at?.toFixed(1)} s`);
  const broke = measured.find(({ tier }) =>
    ["crashed", "unresponsive", "did-not-boot"].includes(tier.ending),
  );
  if (broke) return fail(`${broke.who}: ${broke.tier.ending}`);
  const ended = measured.find(({ tier }) => tier.ending === "won" || tier.ending === "lost");
  return ended
    ? pass(
        `${ended.who} ${ended.tier.ending}${ended.tier.at === null ? "" : ` at ${ended.tier.at.toFixed(1)} s`}`,
      )
    : fail(
        `no play reached an ending (${measured.map(({ who, tier }) => `${who}: ${tier.ending} in ${Math.round(tier.played)} s`).join("; ")})`,
      );
};

const sceneVerdict = (views: ReadonlyArray<GameFactView>): Verdict => {
  const scene = sceneFacts(views);
  if (scene.length === 0) return notMeasured("this server has no scene report");
  const measured = scene.flatMap((view) =>
    view.reading._tag === "measured" ? [{ view, reading: view.reading }] : [],
  );
  if (measured.length === 0)
    return notMeasured(
      scene
        .map((view) =>
          view.reading._tag === "not-measured"
            ? `${view.label}: ${view.reading.why}`
            : `${view.label}: pending`,
        )
        .join("; "),
    );
  const bad = measured.filter(({ reading }) => reading.tone === "bad");
  return bad.length > 0
    ? fail(bad.map(({ view, reading }) => `${view.label}: ${reading.text}`).join("; "))
    : pass(measured.map(({ view, reading }) => `${view.label}: ${reading.text}`).join("; "));
};

const viewVerdict = (views: ReadonlyArray<GameFactView>): Verdict => {
  const empty = views.find((view) => view.id === "empty");
  if (empty === undefined) return notMeasured("this server has no empty-view measure");
  if (empty.reading._tag === "not-measured") return notMeasured(empty.reading.why);
  if (empty.reading._tag === "pending") return notMeasured("still measuring");
  return empty.reading.tone === "bad" ? fail(empty.reading.text) : pass(empty.reading.text);
};

const performanceVerdict = (facts: GameBuildFacts): Verdict => {
  if (facts.performance.status !== "measured")
    return notMeasured(
      facts.performance.status === "pending" ? "still measuring" : facts.performance.why,
    );
  const perf = facts.performance.value;
  const text = `${Math.round(perf.fps)} fps, 1% low ${Math.round(perf.low1)}, ${perf.width}×${perf.height}`;
  return perf.fps >= THRESHOLDS.minFps ? pass(text) : fail(text);
};

/**
 * `firstPlayableSeconds` is from sending the brief to the end of the turn whose
 * build booted; null when no build of the turn booted (or there was none).
 */
const firstPlayableVerdict = (firstPlayableSeconds: number | null, booted: Verdict): Verdict => {
  if (firstPlayableSeconds === null)
    return booted.result === "not-measured"
      ? notMeasured("no measured build")
      : fail("no build booted");
  const text = `${Math.round(firstPlayableSeconds)} s`;
  return firstPlayableSeconds <= THRESHOLDS.firstPlayableSeconds ? pass(text) : fail(text);
};

/**
 * Whether a turn's changed files include the game's own code. A new three.js game
 * is the template's playable starter, which boots and ends by itself: a turn that
 * only wrote STYLE.json or fetched art would score the starter as the brief's
 * game. `web/vendor/` (three.js) and `web/shell/` (the harness) come from the
 * template and `web/assets/` is art, so only the rest of `web/` is the game.
 */
export const changesGameCode = (files: ReadonlyArray<string>) =>
  files.some(
    (path) =>
      path.startsWith("web/") &&
      !["web/vendor/", "web/shell/", "web/assets/"].some((prefix) => path.startsWith(prefix)),
  );

export function scoreGame(input: {
  readonly facts: GameBuildFacts | null;
  /** The build's changed files (the most changed, when `complete` is false); null without a build. */
  readonly files: ReadonlyArray<string> | null;
  /** Whether `files` lists every changed file. */
  readonly complete: boolean;
  readonly turnSeconds: number | null;
  /** Why there are no facts, when there are none. */
  readonly missing: string;
}): GameScore {
  const starter =
    input.files !== null && input.complete && !changesGameCode(input.files)
      ? `the turn changed no game code (${input.files.slice(0, 3).join(", ") || "no files"}${input.files.length > 3 ? ` and ${input.files.length - 3} more` : ""}): what plays is the template's starter`
      : null;
  const facts = starter === null ? input.facts : null;
  const missing = starter ?? input.missing;
  const verdicts: Record<Criterion, Verdict> =
    facts === null
      ? {
          boots: fail(missing),
          ending: notMeasured(missing),
          scene: notMeasured(missing),
          view: notMeasured(missing),
          performance: notMeasured(missing),
          "first-playable": fail(missing),
        }
      : (() => {
          const boots = bootsVerdict(facts);
          const views = gameFactsView(facts);
          return {
            boots,
            ending: endingVerdict(facts),
            scene: sceneVerdict(views),
            view: viewVerdict(views),
            performance: performanceVerdict(facts),
            "first-playable": firstPlayableVerdict(
              boots.result === "pass" ? input.turnSeconds : null,
              boots,
            ),
          };
        })();
  return {
    verdicts,
    passed: CRITERIA.filter((criterion) => verdicts[criterion].result === "pass").length,
    total: CRITERIA.length,
  };
}
