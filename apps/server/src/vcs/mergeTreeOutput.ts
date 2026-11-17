// PURE. Reads `git merge-tree --write-tree -z` (no --name-only): the merged
// tree, every conflicted path's stages, then the informational messages. Git
// documents the format in git-merge-tree(1), "OUTPUT".

/** A blob as one side of a conflict has it. */
export interface MergeSide {
  readonly mode: string;
  readonly oid: string;
}

export interface MergeConflict {
  /** Repository-relative. */
  readonly path: string;
  /** Git could not merge the contents line by line: the result holds `ours` unchanged. */
  readonly binary: boolean;
  /** Stage 1, 2, 3; null where that side has no such file (added or deleted). */
  readonly base: MergeSide | null;
  readonly ours: MergeSide | null;
  readonly theirs: MergeSide | null;
}

export interface MergeTreeOutput {
  readonly tree: string;
  readonly conflicts: ReadonlyArray<MergeConflict>;
}

const STAGE_LINE = /^(\d{6}) ([0-9a-f]{40,64}) ([123])\t([\s\S]+)$/;

export const parseMergeTreeOutput = (stdout: string): MergeTreeOutput => {
  const fields = stdout.split("\0");
  const tree = (fields[0] ?? "").trim();
  if (!/^[0-9a-f]{40,64}$/.test(tree))
    throw new Error(`git merge-tree printed no tree: ${stdout.slice(0, 200)}`);
  const stages = new Map<string, { base?: MergeSide; ours?: MergeSide; theirs?: MergeSide }>();
  let at = 1;
  // Conflicted file info, up to the empty field that ends it. A clean merge prints none.
  for (; at < fields.length; at += 1) {
    const field = fields[at]!;
    if (field === "") break;
    const match = STAGE_LINE.exec(field);
    if (match === null) throw new Error(`git merge-tree printed an unknown line: ${field}`);
    const [, mode, oid, stage, path] = match;
    const entry = stages.get(path!) ?? {};
    const side = { mode: mode!, oid: oid! };
    if (stage === "1") entry.base = side;
    else if (stage === "2") entry.ours = side;
    else entry.theirs = side;
    stages.set(path!, entry);
  }
  // Messages: a count of paths, the paths, a type and the message itself.
  const binary = new Set<string>();
  for (at += 1; at < fields.length;) {
    const count = Number(fields[at]);
    if (!Number.isInteger(count) || count < 1) break;
    const paths = fields.slice(at + 1, at + 1 + count);
    const type = fields[at + 1 + count] ?? "";
    if (type === "CONFLICT (binary)") for (const path of paths) binary.add(path);
    at += count + 3;
  }
  return {
    tree,
    conflicts: [...stages].map(([path, entry]) => ({
      path,
      binary: binary.has(path),
      base: entry.base ?? null,
      ours: entry.ours ?? null,
      theirs: entry.theirs ?? null,
    })),
  };
};
