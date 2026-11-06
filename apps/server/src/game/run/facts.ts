// @effect-diagnostics nodeBuiltinImport:off -- Plain filesystem facts read from the game folder.
// Plain facts for reviewers and testers. States numbers, never interprets them.
// Every reader here is total: what it could not read it says it did not
// measure, never a number made of a failed read, and it never rejects, so a
// prompt built from these facts never fails or pauses the run.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { type GameEngineId, plainReason } from "@kurambit/contracts";
import { assetListSummary, assetUseSummary, readAssetUse } from "./assetUse.ts";
import { engineProfile } from "../engineProfile.ts";
import { spriteFacts } from "./spriteFacts.ts";
import { modelFacts } from "./modelFacts.ts";
import type * as BotEvidence from "../botEvidence.ts";
import { walkFiles } from "../walkFiles.ts";

/** A fact reader's text, or what it could not measure; it never rejects. */
export const total = async (what: string, read: () => Promise<string>): Promise<string> => {
  try {
    return await read();
  } catch (error) {
    return `${what}: not measured (${plainReason(error instanceof Error ? error.message : String(error))}).`;
  }
};

/**
 * The bot runs a reviewer's facts state: one tester's runs on this round's
 * candidate, with the facts-only report of exactly those runs, or why they
 * could not be read.
 */
export type ReviewBots =
  | {
      readonly kind: "runs";
      readonly runs: ReadonlyArray<BotEvidence.BotRun>;
      readonly report: string | null;
    }
  | { readonly kind: "not measured"; readonly why: string }
  | { readonly kind: "none" };

// The bot's fastest finish is a plain fact with no length target beside it;
// the reviewer decides what it means. The runs are the bot service's record,
// never the game folder's copy, which a role agent can write.
const botLine = (runs: ReadonlyArray<BotEvidence.BotRun>): string => {
  if (runs.length === 0) return "this round's tester recorded no bot runs";
  const wins = runs.filter((run) => run.won);
  const explores = runs.filter((run) => run.mode === "explore").length;
  const findings = runs.reduce((sum, run) => sum + run.findings, 0);
  const fastest = wins.length === 0 ? null : Math.min(...wins.map((run) => run.seconds));
  const deciders = [...new Set(runs.map((run) => run.decider))];
  return `on this round's candidate, run by its tester: ${runs.length} bot runs (${explores} exploration, deciders: ${deciders.join("/") || "none"}), ${wins.length} reached the ending${fastest === null ? "" : `, fastest finish ${fastest.toFixed(1)}s`}, ${findings} detector findings`;
};

const botsText = (bots: ReviewBots): string => {
  if (bots.kind === "none") return "";
  if (bots.kind === "not measured") return ` Bots: not measured (${bots.why}).`;
  const report =
    bots.report === null || bots.report.trim().length === 0
      ? ""
      : `\nPlayer report of those runs (facts, no interpretation):\n${bots.report.trim().slice(0, 3000)}`;
  return ` Bots: ${botLine(bots.runs)}.${report}`;
};

/** Which asset files the code loads and how much it draws itself, bounded for a prompt. */
export const assetFacts = (root: string, engine: GameEngineId, lane: string): Promise<string> =>
  total("Asset use", async () => assetUseSummary(await readAssetUse(root, engine, lane), lane));

/** The art stage's facts: ASSETS.md against the disk, and missing files. */
export const artAssetFacts = (root: string, engine: GameEngineId, lane: string): Promise<string> =>
  total("Asset list", async () => assetListSummary(await readAssetUse(root, engine, lane), lane));

/** The sources' sizes and the files by kind, as one sentence. */
const codeFacts = async (root: string, engine: GameEngineId, lane: string): Promise<string> => {
  const { extensions: ext, under } = engineProfile(engine).run.sources;
  const base = NodePath.join(root, lane, under);
  const sources: Array<{ f: string; n: number | null }> = [];
  let images = 0;
  let audio = 0;
  let models = 0;
  // The folders the engine generates are not the game's sources.
  const { skipDirs } = engineProfile(engine).buildInputs;
  const files = await walkFiles(base, {
    enter: (_full, name) => !skipDirs.includes(name) && name !== "builds",
  });
  for (const full of files) {
    const name = NodePath.basename(full);
    if (
      ext.some((suffix) => name.endsWith(suffix)) &&
      !full.includes(`${NodePath.sep}vendor${NodePath.sep}`)
    )
      sources.push({
        f: NodePath.relative(root, full),
        // A file that cannot be read has no line count, not one line.
        n: await NodeFSP.readFile(full, "utf8").then(
          (text) => text.split("\n").length,
          () => null,
        ),
      });
    if (name.endsWith(".import") || name.endsWith(".meta")) continue;
    if (/\.(png|jpg|jpeg|webp|svg)$/i.test(name)) images += 1;
    else if (/\.(wav|ogg|mp3|mid|midi)$/i.test(name)) audio += 1;
    else if (/\.(glb|gltf|fbx|obj|blend)$/i.test(name)) models += 1;
  }
  sources.sort((a, b) => (b.n ?? -1) - (a.n ?? -1));
  const top =
    sources
      .slice(0, 5)
      .map((s) => `${s.f} ${s.n === null ? "(unreadable)" : `${s.n} lines`}`)
      .join("; ") || `no ${ext[0]!.slice(1)} files`;
  return `Largest sources: ${top}. Files: ${images} images, ${audio} audio, ${models} 3D models.`;
};

/** Code facts plus the round tester's bot runs, as one sentence block for the reviewer. */
export const reviewerFacts = async (
  root: string,
  engine: GameEngineId,
  lane: string,
  bots: ReviewBots,
): Promise<string> => {
  const code = await total("Code facts", () => codeFacts(root, engine, lane));
  // Only the notable image facts: the reviewer judges the whole game, not each file.
  const sprites = await total(
    "Image facts",
    async () => (await spriteFacts(root, engine, lane)).notable,
  );
  const modelNotes = await total(
    "Model facts",
    async () => (await modelFacts(root, engine, lane)).notable,
  );
  return `${code} ${await assetFacts(root, engine, lane)}${sprites.length > 0 ? ` ${sprites}` : ""}${modelNotes.length > 0 ? ` Models: ${modelNotes}.` : ""}${botsText(bots)}`;
};
