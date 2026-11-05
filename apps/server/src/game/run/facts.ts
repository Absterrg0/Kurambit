// @effect-diagnostics nodeBuiltinImport:off -- Plain filesystem facts read from the game folder.
// Plain facts for reviewers and testers. States numbers, never interprets them.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { assetListSummary, assetUseSummary, readAssetUse } from "./assetUse.ts";
import { laneProfile } from "../engineProfile.ts";
import { spriteFacts } from "./spriteFacts.ts";
import { modelFacts } from "./modelFacts.ts";
import type * as BotEvidence from "../botEvidence.ts";
import { walkFiles } from "../walkFiles.ts";

const readText = (path: string) => NodeFSP.readFile(path, "utf8").catch(() => "");

// The bot's fastest finish is a plain fact with no length target beside it;
// the reviewer decides what it means. The runs are the bot service's record,
// never the game folder's copy, which a role agent can write.
const botLine = (runs: ReadonlyArray<BotEvidence.BotRun>): string => {
  if (runs.length === 0) return "no bot runs recorded yet";
  const wins = runs.filter((run) => run.won);
  const explores = runs.filter((run) => run.mode === "explore").length;
  const findings = runs.reduce((sum, run) => sum + run.findings, 0);
  const fastest = wins.length === 0 ? null : Math.min(...wins.map((run) => run.seconds));
  const deciders = [...new Set(runs.map((run) => run.decider))];
  return `${runs.length} bot runs (${explores} exploration, deciders: ${deciders.join("/") || "none"}), ${wins.length} reached the ending${fastest === null ? "" : `, fastest finish ${fastest.toFixed(1)}s`}, ${findings} detector findings`;
};

/** Which asset files the code loads and how much it draws itself, bounded for a prompt. */
export const assetFacts = async (root: string, lane: string): Promise<string> =>
  assetUseSummary(await readAssetUse(root, lane), lane);

/** The art stage's facts: ASSETS.md against the disk, and missing files. */
export const artAssetFacts = async (root: string, lane: string): Promise<string> =>
  assetListSummary(await readAssetUse(root, lane), lane);

/** Code facts plus the player report, as one sentence block for the reviewer. */
export const reviewerFacts = async (
  root: string,
  lane: string,
  /** The run's bot runs in this game folder. */
  bots: ReadonlyArray<BotEvidence.BotRun>,
): Promise<string> => {
  const { extensions: ext, under } = laneProfile(lane).run.sources;
  const base = NodePath.join(root, lane, under);
  const sources: Array<{ f: string; n: number }> = [];
  let images = 0;
  let audio = 0;
  let models = 0;
  const files = await walkFiles(base, {
    enter: (_full, name) => name !== ".godot" && name !== "builds",
  });
  for (const full of files) {
    const name = NodePath.basename(full);
    if (
      ext.some((suffix) => name.endsWith(suffix)) &&
      !full.includes(`${NodePath.sep}vendor${NodePath.sep}`)
    )
      sources.push({
        f: NodePath.relative(root, full),
        n: (await readText(full)).split("\n").length,
      });
    if (name.endsWith(".import") || name.endsWith(".meta")) continue;
    if (/\.(png|jpg|jpeg|webp|svg)$/i.test(name)) images += 1;
    else if (/\.(wav|ogg|mp3|mid|midi)$/i.test(name)) audio += 1;
    else if (/\.(glb|gltf|fbx|obj|blend)$/i.test(name)) models += 1;
  }
  sources.sort((a, b) => b.n - a.n);
  const top =
    sources
      .slice(0, 5)
      .map((s) => `${s.f} ${s.n} lines`)
      .join("; ") || `no ${ext[0]!.slice(1)} files`;
  const report = (await readText(NodePath.join(root, ".studio", "player-report.md")))
    .trim()
    .slice(0, 3000);
  // Only the notable image facts: the reviewer judges the whole game, not each file.
  const sprites = (await spriteFacts(root, lane)).notable;
  const modelNotes = (await modelFacts(root, lane)).notable;
  return `Largest sources: ${top}. Files: ${images} images, ${audio} audio, ${models} 3D models. ${await assetFacts(root, lane)}${sprites.length > 0 ? ` ${sprites}` : ""}${modelNotes.length > 0 ? ` Models: ${modelNotes}.` : ""} Bots: ${botLine(bots)}.${report.length > 0 ? `\nPlayer report (facts from bot runs across the game, no interpretation):\n${report}` : "\nNo player report recorded yet."}`;
};
