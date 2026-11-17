// @effect-diagnostics nodeBuiltinImport:off -- The decisions are one small markdown file in the game's folder.
// What the person decided about a game, kept in `.studio/decisions.md` so a session that starts
// fresh (a keep-going step, a new chat, a restart) does not repeat what they turned down. Only the
// harness writes it, from what the person does (an undo, tuned values kept, a step skipped, a note
// they asked it to remember); the person reads and edits it, here or from the Game panel. It is
// outside what a restore puts back (restoredPaths), so an undo never rewinds it.
//
// One entry is one list line: what the person sees, then a comment only the harness reads, with
// when it was added (what an ongoing session is told since its last turn), the build it names and
// keep going's key for it (`decide.ts`'s never-repeat keys). A line someone wrote by hand has no
// comment: fresh sessions read it, and nothing else depends on it.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { GameOperationError, type GameDecision, type ThreadId } from "@kurambit/contracts";
import * as KeyedLock from "@kurambit/shared/KeyedLock";

import * as GameProjectService from "./GameProjectService.ts";
import { ensureGameDir } from "./gameKeptSaves.ts";
import { insideGame } from "./gamePath.ts";

export const DECISIONS_FILE = ".studio/decisions.md";
/** Entries the file keeps; past it the oldest go, the person's own notes last. */
const MOST = 40;
/** About how many characters the block beside a turn's message takes. */
const BLOCK_CHARS = 800;
const LINE_MAX = 300;
const WORDS_MAX = 120;
/**
 * A session whose last turn began before this server did is told everything again: a restart may
 * have cost it its native session, and a resumed one is told once more rather than never.
 */
const SERVER_STARTED = DateTime.formatIso(DateTime.nowUnsafe());

const HEADER = `# Decisions

What you decided about this game. Kurambit adds a line when you undo a build, keep tuned values, skip a keep-going step or ask it to remember something, and every agent session reads the newest. Edit or delete any line. The ${MOST} newest stay; your notes are the last to go.
`;

export type DecisionKind =
  | "undone"
  | "went-back"
  | "kept-values"
  | "kept-over"
  | "brought-in"
  | "skipped"
  | "redid"
  | "note";
const KINDS: ReadonlySet<string> = new Set<DecisionKind>([
  "undone",
  "went-back",
  "kept-values",
  "kept-over",
  "brought-in",
  "skipped",
  "redid",
  "note",
]);
/** What keep going never proposes again: what the person took back or passed over. */
const TURNED_DOWN: ReadonlySet<DecisionKind | null> = new Set<DecisionKind | null>([
  "undone",
  "went-back",
  "skipped",
]);

interface Entry {
  /** Its line in the file, from 0. */
  readonly line: number;
  readonly date: string;
  readonly text: string;
  /** When the harness added or the person last edited it; null on a hand-written line. */
  readonly at: string | null;
  readonly kind: DecisionKind | null;
  readonly key: string | null;
  readonly build: string | null;
  /** An undo whose reason the person's next message may give. */
  readonly awaiting: boolean;
}

const LINE = /^- (.*?)\s*(?:<!-- kurambit (.*?) -->)?\s*$/;
const DATED = /^(\d{4}-\d{2}-\d{2}) · (.*)$/;

const parseLine = (raw: string, line: number): Entry | null => {
  const match = LINE.exec(raw);
  if (match === null) return null;
  const shown = match[1]!.trim();
  const dated = DATED.exec(shown);
  const meta = new Map<string, string>();
  for (const token of (match[2] ?? "").trim().split(/\s+/)) {
    if (token === "") continue;
    const at = token.indexOf("=");
    meta.set(at === -1 ? token : token.slice(0, at), at === -1 ? "" : token.slice(at + 1));
  }
  const kind = meta.get("kind") ?? "";
  return {
    line,
    date: dated?.[1] ?? "",
    text: dated?.[2] ?? shown,
    at: meta.get("at") || null,
    kind: KINDS.has(kind) ? (kind as DecisionKind) : null,
    key: meta.get("key") || null,
    build: meta.get("build") || null,
    awaiting: meta.has("awaiting"),
  };
};

const lineOf = (entry: Omit<Entry, "line">) => {
  const meta = [
    ...(entry.at === null ? [] : [`at=${entry.at}`]),
    ...(entry.kind === null ? [] : [`kind=${entry.kind}`]),
    ...(entry.build === null ? [] : [`build=${entry.build}`]),
    ...(entry.key === null ? [] : [`key=${entry.key}`]),
    ...(entry.awaiting ? ["awaiting"] : []),
  ];
  const shown = entry.date === "" ? entry.text : `${entry.date} · ${entry.text}`;
  return meta.length === 0 ? `- ${shown}` : `- ${shown} <!-- kurambit ${meta.join(" ")} -->`;
};

/** One line of the person's or the harness's words: no line breaks, no comment markers. */
const oneLine = (text: string, max = LINE_MAX) => {
  const flat = text
    .replace(/<!--|-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** The day on the server's own clock and zone: the person's machine. */
const dayOf = (now: DateTime.Utc) =>
  DateTime.formatIsoDate(DateTime.makeZonedUnsafe(now, { timeZone: DateTime.zoneMakeLocal() }));

interface Parsed {
  readonly lines: ReadonlyArray<string>;
  readonly entries: ReadonlyArray<Entry>;
}

const parse = (text: string | null): Parsed => {
  const lines = text === null ? HEADER.split("\n") : text.replace(/\r\n/g, "\n").split("\n");
  const entries = lines.flatMap((raw, line) => {
    const entry = parseLine(raw, line);
    return entry === null ? [] : [entry];
  });
  return { lines, entries };
};

/** Past MOST entries the oldest go, the person's own notes only when nothing else is left. */
const capped = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  const { entries } = parse(lines.join("\n"));
  const over = entries.length - MOST;
  if (over <= 0) return lines;
  const others = entries.filter((each) => each.kind !== "note");
  const notes = entries.filter((each) => each.kind === "note");
  const gone = new Set([...others, ...notes].slice(0, over).map((each) => each.line));
  return lines.filter((_, index) => !gone.has(index));
};

const fileOf = (root: string) => insideGame(root, DECISIONS_FILE);

const readText = async (root: string) =>
  NodeFSP.readFile(fileOf(root), "utf8").catch((cause: NodeJS.ErrnoException) => {
    if (cause?.code === "ENOENT") return null;
    throw cause;
  });

const writeLines = async (root: string, lines: ReadonlyArray<string>) => {
  const dir = await ensureGameDir(root, NodePath.dirname(DECISIONS_FILE));
  const text = `${lines.join("\n").replace(/\n+$/, "")}\n`;
  const temporary = NodePath.join(dir, ".decisions.md.tmp");
  await NodeFSP.writeFile(temporary, text);
  await NodeFSP.rename(temporary, fileOf(root));
};

/** When an entry is added: the time a session compares, the day a person reads. */
interface Stamp {
  readonly at: string;
  readonly day: string;
}

// A refusal of the path (a link out of the game) is already the answer.
const fileFailure = (root: string, what: string) => (cause: unknown) =>
  isGameOperationError(cause)
    ? cause
    : new GameOperationError({
        operation: "Decisions",
        path: NodePath.join(root, DECISIONS_FILE),
        reason: "io",
        detail: `${DECISIONS_FILE} could not be ${what}`,
        cause,
      });

const read = (root: string) =>
  Effect.tryPromise({
    try: async () => parse(await readText(root)),
    catch: fileFailure(root, "read"),
  });

const isGameOperationError = Schema.is(GameOperationError);

// Every change is a read, a change and a write of one file: one at a time per game.
const lock = Effect.runSync(KeyedLock.make<string>());

/** Reads the file, lets `change` rewrite its lines (null: leave it), and writes it back. */
const change = <A>(
  root: string,
  edit: (
    parsed: Parsed,
    now: Stamp,
  ) => { readonly lines: ReadonlyArray<string> | null; readonly value: A },
) =>
  lock.withLock(
    NodePath.resolve(root),
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const parsed = yield* read(root);
      const result = edit(parsed, { at: DateTime.formatIso(now), day: dayOf(now) });
      if (result.lines !== null) {
        const lines = capped(result.lines);
        yield* Effect.tryPromise({
          try: () => writeLines(root, lines),
          catch: fileFailure(root, "written"),
        });
      }
      return result.value;
    }),
  );

export interface DecisionInput {
  readonly kind: DecisionKind;
  readonly text: string;
  readonly build?: string | null;
  /** Keep going's never-repeat key for what was decided. */
  readonly key?: string | null;
  readonly awaiting?: boolean;
  /** Entries of the same kind naming this build give way to this one (a tuning session's fold). */
  readonly replaces?: string;
}

/**
 * Adds one entry, newest last. A decision is never worth failing what the person did, so a
 * caller logs a failure and goes on.
 */
export const recordDecision = (root: string, input: DecisionInput) =>
  change(root, ({ lines, entries }, now) => {
    const replaced = new Set(
      entries
        .filter(
          (each) =>
            input.replaces !== undefined &&
            each.kind === input.kind &&
            each.build === input.replaces,
        )
        .map((each) => each.line),
    );
    const entry = lineOf({
      date: now.day,
      text: oneLine(input.text),
      at: now.at,
      kind: input.kind,
      build: input.build ?? null,
      key: input.key ?? null,
      awaiting: input.awaiting === true,
    });
    const kept = trailing(lines);
    return {
      lines: [...lines.filter((each, index) => kept(each, index) && !replaced.has(index)), entry],
      value: undefined,
    };
  });

// The file's trailing blank lines, so a new entry follows the last one directly.
const trailing = (lines: ReadonlyArray<string>) => {
  let last = lines.length - 1;
  while (last >= 0 && lines[last]!.trim() === "") last -= 1;
  return (_: string, index: number) => index <= last;
};

/** Removes the harness's entries `which` picks (a Redo takes its undo back); how many went. */
export const dropDecisions = (
  root: string,
  which: (entry: { readonly kind: DecisionKind | null; readonly build: string | null }) => boolean,
) =>
  change(root, ({ lines, entries }) => {
    const gone = new Set(entries.filter(which).map((each) => each.line));
    return {
      lines: gone.size === 0 ? null : lines.filter((_, index) => !gone.has(index)),
      value: gone.size,
    };
  });

/** The entries naming `build` (a tuning session's last keep, which the next one folds into). */
export const decisionsOfBuild = (root: string, build: string) =>
  Effect.map(read(root), ({ entries }) =>
    entries
      .filter((each) => each.build === build)
      .map((each) => ({ kind: each.kind, text: each.text })),
  );

/**
 * The person's message after an undo: its first sentence goes on the newest undo still waiting
 * for one, in their words, and no undo waits any longer. Unchanged without a waiting undo.
 */
const attachWords = (root: string, message: string) =>
  change(root, ({ lines, entries }) => {
    const waiting = entries.filter((each) => each.awaiting);
    const newest = waiting.at(-1);
    const words = oneLine(/^(.+?[.!?])(?:\s|$)/.exec(oneLine(message))?.[1] ?? message, WORDS_MAX);
    if (newest === undefined) return { lines: null, value: undefined };
    const next = [...lines];
    for (const each of waiting)
      next[each.line] = lineOf({
        ...each,
        text: each === newest && words !== "" ? `${each.text} Next message: "${words}"` : each.text,
        awaiting: false,
      });
    return { lines: next, value: undefined };
  });

/**
 * The block for a turn's message: everything, newest first, for a session that starts fresh
 * (`since` absent, or before this server started); only what was added or edited since `since`
 * for one that goes on. Null when there is nothing to tell. A person's own message (`words`) is
 * first put on an undo waiting for their reason.
 */
export const decisionsForTurn = (
  root: string,
  input: { readonly since?: string; readonly words?: string },
) =>
  Effect.gen(function* () {
    if (input.words !== undefined && input.words.trim() !== "")
      yield* attachWords(root, input.words);
    const { entries } = yield* read(root);
    const fresh = input.since === undefined || input.since < SERVER_STARTED;
    const told = fresh
      ? entries
      : entries.filter((each) => each.at !== null && each.at > input.since!);
    return blockOf(told, fresh);
  });

const blockOf = (entries: ReadonlyArray<Entry>, fresh: boolean): string | null => {
  if (entries.length === 0) return null;
  const header = fresh
    ? `The person's decisions about this game, newest first (all of them are in \`${DECISIONS_FILE}\`). Hold to them unless the person asks otherwise.`
    : "Since your last turn the person decided, newest first:";
  const lines: Array<string> = [];
  let used = header.length;
  const newest = entries.toReversed();
  for (const entry of newest) {
    const line = `- ${entry.date === "" ? "" : `${entry.date} `}${entry.text}`;
    if (lines.length > 0 && used + line.length > BLOCK_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  const more = newest.length - lines.length;
  return [header, ...lines, ...(more > 0 ? [`- and ${more} older in the file`] : [])].join("\n");
};

/** Keep going's never-repeat keys of what the person undid, went back from or skipped. */
export const decidedKeys = (root: string) =>
  Effect.map(read(root), ({ entries }) => [
    ...new Set(
      entries.flatMap((each) =>
        each.key !== null && TURNED_DOWN.has(each.kind) ? [each.key] : [],
      ),
    ),
  ]);

const listOf = ({ entries }: Parsed): ReadonlyArray<GameDecision> =>
  entries.map((each) => ({
    line: each.line,
    date: each.date,
    text: each.text,
    ...(each.kind === null ? {} : { kind: each.kind }),
    ...(each.build === null ? {} : { build: each.build }),
  }));

export class GameDecisions extends Context.Service<
  GameDecisions,
  {
    /** The file's entries, oldest first, as the person reads them. */
    readonly list: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<GameDecision>, GameOperationError>;
    /**
     * The person's change from the Game panel or the composer: a note to remember, or one line
     * edited or deleted. A line that no longer reads as it did is refused, so an edit never lands
     * on another entry. Answers the entries after it.
     */
    readonly decide: (
      threadId: ThreadId,
      change:
        | { readonly _tag: "note"; readonly text: string }
        | {
            readonly _tag: "edit";
            readonly line: number;
            readonly was: string;
            readonly text: string;
          }
        | { readonly _tag: "remove"; readonly line: number; readonly was: string },
    ) => Effect.Effect<ReadonlyArray<GameDecision>, GameOperationError>;
  }
>()("kurambit/game/GameDecisions") {}

const make = Effect.gen(function* () {
  const projects = yield* GameProjectService.GameProjectService;
  const failed = (root: string, detail: string) =>
    new GameOperationError({
      operation: "Decisions",
      path: NodePath.join(root, DECISIONS_FILE),
      reason: "invalid-input",
      detail,
    });

  const list: GameDecisions["Service"]["list"] = (threadId) =>
    Effect.flatMap(projects.home(threadId), ({ root }) => Effect.map(read(root), listOf));

  const decide: GameDecisions["Service"]["decide"] = (threadId, input) =>
    Effect.gen(function* () {
      // One decisions file per game, at its home: a chat in a copy decides for the game.
      const { root } = yield* projects.home(threadId);
      const text = input._tag === "remove" ? "" : oneLine(input.text);
      if (input._tag !== "remove" && text === "")
        return yield* failed(root, "Write something to keep, or delete the line.");
      const refused = yield* change(root, (parsed, now) => {
        if (input._tag === "note")
          return {
            lines: [
              ...parsed.lines.filter(trailing(parsed.lines)),
              lineOf({
                date: now.day,
                text: `Note: ${text.replace(/^note:\s*/i, "")}`,
                at: now.at,
                kind: "note",
                build: null,
                key: null,
                awaiting: false,
              }),
            ],
            value: false,
          };
        const entry = parsed.entries.find((each) => each.line === input.line);
        if (entry === undefined || entry.text !== input.was) return { lines: null, value: true };
        const next = [...parsed.lines];
        if (input._tag === "remove") next.splice(input.line, 1);
        // An edit is the person's word now: stamped again, so a session going on hears it.
        else next[input.line] = lineOf({ ...entry, text, at: now.at, awaiting: false });
        return { lines: next, value: false };
      });
      if (refused)
        return yield* failed(
          root,
          "That line changed since you opened it: look at the decisions again, then edit it.",
        );
      return listOf(yield* read(root));
    });

  return GameDecisions.of({ list, decide });
});

export const layer = Layer.effect(GameDecisions, make);
