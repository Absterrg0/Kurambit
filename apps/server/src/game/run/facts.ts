// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- Plain filesystem facts read from the game folder; bot-result rows are tolerant per line.
// Plain facts for reviewers and testers. States numbers, never interprets them.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { assetListSummary, assetUseSummary, readAssetUse } from "./assetUse.ts";
import { laneBots } from "./roles.ts";

const readText = (path: string) => NodeFSP.readFile(path, "utf8").catch(() => "");

export const botRunCount = async (root: string): Promise<number> =>
  (await readText(NodePath.join(root, ".studio", "bot-results.jsonl"))).split("\n").filter(Boolean)
    .length;

const walk = async (
  dir: string,
  visit: (full: string, name: string) => Promise<void>,
  skip: ReadonlyArray<string>,
) => {
  for (const entry of await NodeFSP.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skip.includes(entry.name)) await walk(full, visit, skip);
    } else await visit(full, entry.name);
  }
};

// The bot's fastest finish is a plain fact with no length target beside it;
// the reviewer decides what it means.
const botLine = async (root: string): Promise<string> => {
  const lines = (await readText(NodePath.join(root, ".studio", "bot-results.jsonl")))
    .split("\n")
    .filter(Boolean);
  if (lines.length === 0) return "no bot runs recorded yet";
  let wins = 0;
  let explores = 0;
  let findings = 0;
  let fastest: number | null = null;
  const deciders = new Set<string>();
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as {
        won?: unknown;
        seconds?: unknown;
        findings?: unknown;
        mode?: unknown;
        decider?: unknown;
      };
      if (row.mode === "explore") explores += 1;
      if (typeof row.decider === "string") deciders.add(row.decider);
      if (typeof row.findings === "number") findings += row.findings;
      if (row.won === true) {
        wins += 1;
        if (typeof row.seconds === "number" && (fastest === null || row.seconds < fastest))
          fastest = row.seconds;
      }
    } catch {
      // One bad line never breaks the facts.
    }
  }
  return `${lines.length} bot runs (${explores} exploration, deciders: ${[...deciders].join("/") || "none"}), ${wins} reached the ending${fastest === null ? "" : `, fastest finish ${fastest.toFixed(1)}s`}, ${findings} detector findings`;
};

/** Which asset files the code loads and how much it draws itself, bounded for a prompt. */
export const assetFacts = async (root: string, lane: string): Promise<string> =>
  assetUseSummary(await readAssetUse(root, lane), lane);

/** The art stage's facts: ASSETS.md against the disk, and missing files. */
export const artAssetFacts = async (root: string, lane: string): Promise<string> =>
  assetListSummary(await readAssetUse(root, lane), lane);

/** Code facts plus the player report, as one sentence block for the reviewer. */
export const reviewerFacts = async (root: string, lane: string): Promise<string> => {
  const ext = lane === "godot" ? [".gd"] : lane === "unity" ? [".cs"] : [".js", ".mjs"];
  // A Unity project's own files live under Assets/; everything beside it is generated.
  const base = lane === "unity" ? NodePath.join(root, lane, "Assets") : NodePath.join(root, lane);
  const sources: Array<{ f: string; n: number }> = [];
  let images = 0;
  let audio = 0;
  let models = 0;
  await walk(
    base,
    async (full, name) => {
      if (
        ext.some((suffix) => name.endsWith(suffix)) &&
        !full.includes(`${NodePath.sep}vendor${NodePath.sep}`)
      )
        sources.push({
          f: NodePath.relative(root, full),
          n: (await readText(full)).split("\n").length,
        });
      if (name.endsWith(".import") || name.endsWith(".meta")) return;
      if (/\.(png|jpg|jpeg|webp|svg)$/i.test(name)) images += 1;
      else if (/\.(wav|ogg|mp3|mid|midi)$/i.test(name)) audio += 1;
      else if (/\.(glb|gltf|fbx|obj|blend)$/i.test(name)) models += 1;
    },
    [".godot", "builds"],
  );
  sources.sort((a, b) => b.n - a.n);
  const top =
    sources
      .slice(0, 5)
      .map((s) => `${s.f} ${s.n} lines`)
      .join("; ") || `no ${ext[0]!.slice(1)} files`;
  const report = (await readText(NodePath.join(root, ".studio", "player-report.md")))
    .trim()
    .slice(0, 3000);
  return `Largest sources: ${top}. Files: ${images} images, ${audio} audio, ${models} 3D models. ${await assetFacts(root, lane)} Bots: ${laneBots(lane) ? await botLine(root) : "bot runs do not play this engine's games"}.${report.length > 0 ? `\nPlayer report (facts from bot runs across the game, no interpretation):\n${report}` : "\nNo player report recorded yet."}`;
};
