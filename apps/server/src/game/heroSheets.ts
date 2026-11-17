// @effect-diagnostics nodeBuiltinImport:off -- Reads and copies a game's sheet files on disk.
// The hero sheet gate: a character or creature is done when its sheet is kept in art/sheets/ and
// the agent's critique of that sheet sits beside it. The tools keep the sheets (the Blender
// export, the code model sheet), and keeping a new one moves the old critique aside, so a critique
// always answers the sheet beside it, whatever an undo restores. The final check lists what is
// missing: finishing the loop is the harness's call, not the model's mood.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  GAME_MODEL_SIDECAR_SUFFIX,
  gameHeroSheetName,
  type GameHeroSheet,
} from "@kurambit/contracts";
import { walkFiles } from "./walkFiles.ts";

const HERO_SHEET_DIR = "art/sheets";
/** Thing kinds whose model sheet is kept as a hero sheet. */
export const HERO_KINDS: ReadonlySet<string> = new Set(["character", "creature"]);
/** A critique shorter than this, or with no numbered line, is a placeholder. */
const MIN_CRITIQUE_CHARS = 120;
const MAX_SIDECARS = 200;

/** A critique as Art shows it. */
const MAX_CRITIQUE_CHARS = 4000;

/**
 * Copies a sheet picture to art/sheets/<name>.png, and moves the critique of the sheet it replaces
 * to <name>.previous.md; returns the sheet game-relative. The same picture again changes nothing:
 * an export keeps the review its critique was written against.
 */
export const keepHeroSheet = async (root: string, name: string, image: string) => {
  const folder = NodePath.join(root, HERO_SHEET_DIR);
  await NodeFSP.mkdir(folder, { recursive: true });
  const stem = gameHeroSheetName(name);
  const target = NodePath.join(folder, `${stem}.png`);
  const [next, kept] = await Promise.all([
    NodeFSP.readFile(image),
    NodeFSP.readFile(target).catch(() => null),
  ]);
  if (kept === null || !kept.equals(next)) {
    await NodeFSP.rename(
      NodePath.join(folder, `${stem}.md`),
      NodePath.join(folder, `${stem}.previous.md`),
    ).catch(() => undefined);
    await NodeFSP.writeFile(target, next);
  }
  return `${HERO_SHEET_DIR}/${stem}.png`;
};

const isFile = (path: string) =>
  NodeFSP.stat(path).then(
    (stat) => stat.isFile(),
    () => false,
  );

/** The critique beside a kept sheet, when it is one: numbered, more than a line. */
const heroCritique = async (root: string, sheet: string) => {
  const text = await NodeFSP.readFile(
    NodePath.join(root, sheet.replace(/\.png$/, ".md")),
    "utf8",
  ).catch(() => "");
  return text.trim().length >= MIN_CRITIQUE_CHARS && /^\s*1[.)]/m.test(text) ? text : null;
};

/** The kept sheets, game-relative. */
const keptSheets = async (root: string) =>
  (
    await walkFiles(NodePath.join(root, HERO_SHEET_DIR), {
      match: (name) => name.endsWith(".png"),
      maxDepth: 0,
      limit: MAX_SIDECARS,
    })
  ).map((full) => NodePath.relative(root, full).split(NodePath.sep).join("/"));

/** Every kept sheet with its critique, for Art. */
export const listHeroSheets = async (root: string): Promise<ReadonlyArray<GameHeroSheet>> =>
  Promise.all(
    (await keptSheets(root)).map(async (image) => {
      const critique = await heroCritique(root, image);
      return {
        name: NodePath.posix.basename(image, ".png"),
        image,
        ...(critique === null ? {} : { critique: critique.slice(0, MAX_CRITIQUE_CHARS) }),
      };
    }),
  );

type SidecarGate = {
  readonly name: string;
  readonly pass: boolean;
  readonly value: number;
  readonly text: string;
};

const sidecarGates = (text: string): ReadonlyArray<SidecarGate> => {
  try {
    const parsed = JSON.parse(text) as { gates?: unknown };
    return Array.isArray(parsed.gates)
      ? parsed.gates.filter(
          (gate): gate is SidecarGate =>
            typeof gate === "object" &&
            gate !== null &&
            typeof (gate as SidecarGate).name === "string" &&
            typeof (gate as SidecarGate).pass === "boolean" &&
            typeof (gate as SidecarGate).value === "number" &&
            typeof (gate as SidecarGate).text === "string",
        )
      : [];
  } catch {
    return [];
  }
};

/** The numbers a critique has to quote: its height and its deformation, as the review printed them. */
const quoted = (gates: ReadonlyArray<SidecarGate>) =>
  gates
    .filter((gate) => gate.name === "height" || gate.name === "deformation")
    .map((gate) => gate.value.toFixed(2));

/**
 * What the gate still wants, one line each, and every exported hero's measured gates. Wanted: a
 * character model exported with no sheet kept, a kept sheet with no critique written after it, a
 * gate the hero fails, and a critique that does not quote the hero's measured numbers. `paths`
 * are the game's (gamePaths): exports land under its assets folder, never in the library's.
 */
export const heroSheetProblems = async (
  root: string,
  paths: { readonly assets: string; readonly library: string },
): Promise<{ readonly problems: ReadonlyArray<string>; readonly gates: ReadonlyArray<string> }> => {
  const problems: Array<string> = [];
  const gateLines: Array<string> = [];
  const library = NodePath.join(root, paths.library);
  const sidecars = await walkFiles(NodePath.join(root, paths.assets), {
    enter: (full) => full !== library,
    match: (name) => name.endsWith(GAME_MODEL_SIDECAR_SUFFIX),
    limit: MAX_SIDECARS,
  });
  for (const sidecar of sidecars) {
    const text = await NodeFSP.readFile(sidecar, "utf8").catch(() => "");
    if (!/"kind"\s*:\s*"character"/.test(text)) continue;
    const stem = NodePath.basename(sidecar).slice(0, -GAME_MODEL_SIDECAR_SUFFIX.length);
    const sheet = `${HERO_SHEET_DIR}/${gameHeroSheetName(stem)}.png`;
    const gates = sidecarGates(text);
    for (const gate of gates) {
      gateLines.push(`${stem} ${gate.name} ${gate.pass ? "passes" : "FAILS"}: ${gate.text}`);
      if (!gate.pass)
        problems.push(
          `${stem}: fails its ${gate.name} gate: ${gate.text}. Fix it, review and export again.`,
        );
    }
    if (!(await isFile(NodePath.join(root, sheet)))) {
      problems.push(
        `${stem}: no hero sheet at ${sheet}. Review it (game_blender op look mode review) and export it again, which keeps the sheet.`,
      );
      continue;
    }
    const critique = await heroCritique(root, sheet);
    const numbers = quoted(gates);
    if (critique !== null && numbers.some((number) => !critique.includes(number)))
      problems.push(
        `${sheet.replace(/\.png$/, ".md")} does not quote ${stem}'s measured gates (height ${numbers[0] ?? "?"}, deformation ${numbers[1] ?? "?"}): put the review's gate numbers in the critique and what each means for the hero.`,
      );
  }
  for (const sheet of await keptSheets(root)) {
    if ((await heroCritique(root, sheet)) === null)
      problems.push(
        `${sheet}: no critique of it at ${sheet.replace(/\.png$/, ".md")}. Look at the sheet, write the numbered critique against the brief, fix what blocks, and sheet it again (studio-skills/art-pipeline.md, The hero sheet).`,
      );
  }
  return { problems, gates: gateLines };
};
