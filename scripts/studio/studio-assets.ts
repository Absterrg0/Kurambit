#!/usr/bin/env node
// studio-assets: the one small shelf command builders can run.
// Sources: kits pinned in apps/server/assets/art-kits, ambientCG and
// Poly Haven (public JSON APIs), and the Godot asset library API.
// Everything fetched is written into the game with source + licence
// appended to ASSETS.md. Notes from verification (2026-10-30):
// Poly Haven assets are CC0 (polyhaven.com/license), but api.polyhaven.org
// returned HTTP 522 from this host, so live fetch falls back to the other
// sources. ambientCG full_json works; assets there are CC0. The Godot asset
// library API works; each addon carries its own licence, recorded per fetch.
// sfxr/FluidSynth are not installed here (would need sudo) and Quaternius
// downloads need an interactive itch.io claim, so generated WAVs (Python
// wave) and the pinned kits are the working routes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const checkout = NodeURL.fileURLToPath(new URL("../..", import.meta.url));
const KITS = NodePath.join(checkout, "apps/server/assets/art-kits");
const { values, positionals } = NodeUtil.parseArgs({
  options: {
    game: { type: "string" },
    licence: { type: "string", default: "" },
  },
  allowPositionals: true,
});
const [command, ...rest] = positionals;
const gameDir = NodePath.resolve(values.game ?? process.cwd());
const shelfDir = NodePath.join(gameDir, "godot", "assets", "shelf");

const appendAssets = async (lines: string): Promise<void> => {
  await NodeFSP.mkdir(NodePath.dirname(NodePath.join(gameDir, "ASSETS.md")), { recursive: true });
  await NodeFSP.appendFile(NodePath.join(gameDir, "ASSETS.md"), lines);
};
const fetchJson = async (url: string, init?: RequestInit, timeoutMs = 25000): Promise<unknown> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
};
const fetchFile = async (url: string, dest: string, timeoutMs = 60000): Promise<void> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await NodeFSP.mkdir(NodePath.dirname(dest), { recursive: true });
    await NodeFSP.writeFile(dest, Buffer.from(await response.arrayBuffer()));
  } finally {
    clearTimeout(timer);
  }
};

if (command === "list") {
  const kits = (await NodeFSP.readdir(KITS, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  console.log(`kits: ${kits.join(", ") || "(none)"}`);
  process.exit(0);
}
if (command === "kits") {
  // kits <name> : copy a pinned kit into the game.
  const name = rest[0];
  if (!name) {
    console.log("usage: studio-assets --game DIR kits <name>");
    process.exit(2);
  }
  const from = NodePath.join(KITS, name);
  const licence = await NodeFSP.readFile(NodePath.join(from, "License.txt"), "utf8").catch(
    () => "",
  );
  const dest = NodePath.join(shelfDir, name);
  await NodeFSP.rm(dest, { recursive: true, force: true });
  await NodeFSP.cp(from, dest, { recursive: true });
  const provenance = await NodeFSP.readFile(NodePath.join(from, "PROVENANCE.md"), "utf8").catch(
    () => "",
  );
  await appendAssets(
    `\n## shelf/${name}\nSource: pinned kit apps/server/assets/art-kits/${name}. ` +
      `Licence: CC0 1.0 Universal. ${licence.split("\n")[0] ?? ""}\n${provenance}\n`,
  );
  console.log(`studio-assets: kit ${name} -> godot/assets/shelf/${name}`);
  process.exit(0);
}
if (command === "search") {
  // search <term> : query the Godot asset library + ambientCG, print hits.
  const term = rest.join(" ");
  const godot = (await fetchJson(
    `https://godotengine.org/asset-library/api/asset?godot_version=4.7&max_results=8&filter=${encodeURIComponent(term)}`,
  ).catch((error: unknown) => ({ error: String(error) }))) as {
    result?: Array<{ title?: string; asset_id?: string; cost?: string }>;
  };
  for (const hit of godot.result ?? [])
    console.log(`godot-lib: ${hit.title} (id ${hit.asset_id}, licence ${hit.cost})`);
  if (!godot.result) console.log("godot-lib: unreachable.");
  try {
    const ambient = (await fetchJson("https://ambientcg.com/api/v2/full_json")) as {
      assets?: Array<{ assetId?: string; displayName?: string }>;
    };
    const query = term.toLowerCase();
    const hits = (ambient.assets ?? [])
      .filter((asset) =>
        `${asset.assetId ?? ""} ${asset.displayName ?? ""}`.toLowerCase().includes(query),
      )
      .slice(0, 8);
    for (const hit of hits) console.log(`ambientcg: ${hit.displayName} (${hit.assetId}, CC0)`);
    if (hits.length === 0) console.log("ambientcg: no matches.");
  } catch {
    console.log("ambientcg: unreachable.");
  }
  try {
    await fetchJson("https://api.polyhaven.org/api/docs");
    console.log("polyhaven: api reachable.");
  } catch {
    console.log("polyhaven: api unreachable from here (HTTP 522 at verification); assets are CC0.");
  }
  process.exit(0);
}
if (command === "fetch") {
  // fetch <url> <destRel> : download one file into the game + record it.
  const [url, destRel] = rest;
  if (!url || !destRel) {
    console.log("usage: studio-assets --game DIR fetch <url> <destRel> [--licence TEXT]");
    process.exit(2);
  }
  const dest = NodePath.join(gameDir, "godot", destRel);
  await fetchFile(url, dest);
  await appendAssets(
    `\n## ${destRel}\nSource: ${url}. Licence: ${values.licence || "unknown - verify before shipping"}.\n`,
  );
  console.log(`studio-assets: ${url} -> godot/${destRel}`);
  process.exit(0);
}
if (command === "probe-audio") {
  // probe-audio : try sfxr / FluidSynth / quaternius once each, print what works.
  const which = (bin: string): boolean => {
    try {
      NodeChildProcess.execFileSync("which", [bin], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  console.log(
    `sfxr: ${which("sfxr") || which("sfxr-qt") ? "installed" : "not installed (needs sudo/build); use Python wave"}`,
  );
  console.log(
    `fluidsynth: ${which("fluidsynth") ? "installed" : "not installed (needs sudo); use Python wave"}`,
  );
  console.log(
    "quaternius: itch.io claim is interactive; no automatic download (use pinned Kenney kits)",
  );
  try {
    NodeChildProcess.execFileSync("python3", ["-c", "import wave,struct,math"]);
    console.log("python-wave: works");
  } catch {
    console.log("python-wave: broken");
  }
  process.exit(0);
}
console.log(
  "usage: studio-assets --game DIR <list|kits <name>|search <term>|fetch <url> <destRel>|probe-audio>",
);
process.exit(2);
