import type { TurnDiffFileChange } from "../../types";

/**
 * What a changed file means to the game, not to a repository. The order is the
 * order a creator thinks in: the world first, then its behaviour, then looks
 * and sound, then the written design.
 */
export type GameChangeKind = "scenes" | "scripts" | "models" | "art" | "design" | "other";

export interface GameChangeGroup {
  kind: GameChangeKind;
  count: number;
  additions: number;
  deletions: number;
}

const GROUP_ORDER: readonly GameChangeKind[] = [
  "scenes",
  "scripts",
  "models",
  "art",
  "design",
  "other",
];

const GROUP_LABELS: Record<GameChangeKind, { one: string; many: string }> = {
  scenes: { one: "scene", many: "scenes" },
  scripts: { one: "script", many: "scripts" },
  models: { one: "model", many: "models" },
  art: { one: "art & audio file", many: "art & audio files" },
  design: { one: "design doc", many: "design docs" },
  other: { one: "other file", many: "other files" },
};

const EXTENSION_KINDS: Readonly<Record<string, GameChangeKind>> = {
  tscn: "scenes",
  scn: "scenes",
  gd: "scripts",
  gdshader: "scripts",
  shader: "scripts",
  py: "scripts",
  glb: "models",
  gltf: "models",
  blend: "models",
  fbx: "models",
  obj: "models",
  png: "art",
  jpg: "art",
  jpeg: "art",
  webp: "art",
  svg: "art",
  gif: "art",
  bmp: "art",
  wav: "art",
  ogg: "art",
  mp3: "art",
  flac: "art",
  ttf: "art",
  otf: "art",
  md: "design",
  txt: "design",
};

export function gameChangeKind(path: string): GameChangeKind {
  const dot = path.lastIndexOf(".");
  if (dot < 0 || dot === path.length - 1) return "other";
  return EXTENSION_KINDS[path.slice(dot + 1).toLowerCase()] ?? "other";
}

export function groupGameChanges(files: ReadonlyArray<TurnDiffFileChange>): GameChangeGroup[] {
  const groups = new Map<GameChangeKind, GameChangeGroup>();
  for (const file of files) {
    const kind = gameChangeKind(file.path);
    const existing = groups.get(kind);
    if (existing === undefined) {
      groups.set(kind, {
        kind,
        count: 1,
        additions: file.additions,
        deletions: file.deletions,
      });
    } else {
      existing.count += 1;
      existing.additions += file.additions;
      existing.deletions += file.deletions;
    }
  }
  return GROUP_ORDER.flatMap((kind) => {
    const group = groups.get(kind);
    return group === undefined ? [] : [group];
  });
}

/** One line per turn: "Changed 2 scenes · 3 scripts · 1 model". */
export function formatGameChangeSummary(groups: ReadonlyArray<GameChangeGroup>): string {
  if (groups.length === 0) return "No changes";
  const parts = groups.map((group) => {
    const labels = GROUP_LABELS[group.kind];
    return `${group.count} ${group.count === 1 ? labels.one : labels.many}`;
  });
  return `Changed ${parts.join(" · ")}`;
}
