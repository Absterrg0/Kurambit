// @effect-diagnostics nodeBuiltinImport:off -- The decisions are a file in a scratch game folder.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";

import {
  DECISIONS_FILE,
  decidedKeys,
  decisionsForTurn,
  dropDecisions,
  recordDecision,
} from "./GameDecisions.ts";

const inGame = <A, E>(work: (root: string) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "decisions-"))),
    work,
    (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
  );
const fileText = (root: string) =>
  Effect.promise(() => NodeFSP.readFile(NodePath.join(root, DECISIONS_FILE), "utf8"));
/** The test clock starts at 0; this server started now, so a session going on reads from now. */
const goOn = (millis: number) => TestClock.setTime(Date.now() + millis);
const isoAt = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(Date.now() + millis));

it.effect("keeps the newest 40, the person's own notes last to go", () =>
  inGame((root) =>
    Effect.gen(function* () {
      yield* goOn(0);
      yield* recordDecision(root, { kind: "note", text: "Note: keep it one-button" });
      for (let n = 1; n <= 44; n += 1)
        yield* recordDecision(root, { kind: "undone", text: `Undid Build ${n}: change ${n}` });
      const text = yield* fileText(root);
      const lines = text.split("\n").filter((line) => line.startsWith("- "));
      expect(lines).toHaveLength(40);
      expect(text).toContain("Note: keep it one-button");
      expect(text).not.toContain("Undid Build 5:");
      expect(text).toContain("Undid Build 6:");
      expect(text.startsWith("# Decisions")).toBe(true);
    }),
  ),
);

it.effect("tells a fresh session everything and a session going on only what is new", () =>
  inGame((root) =>
    Effect.gen(function* () {
      yield* goOn(1_000);
      yield* recordDecision(root, {
        kind: "undone",
        text: "Undid Build 3: Added a dash on Shift.",
        key: "next:abc",
        awaiting: true,
      });
      yield* goOn(2_000);
      yield* recordDecision(root, {
        kind: "kept-values",
        text: "Kept tuned values: player jump 9 → 12",
      });
      const fresh = yield* decisionsForTurn(root, {});
      expect(fresh?.split("\n").slice(1)).toEqual([
        expect.stringContaining("Kept tuned values: player jump 9 → 12"),
        expect.stringContaining("Undid Build 3: Added a dash on Shift."),
      ]);
      const since = yield* decisionsForTurn(root, { since: isoAt(1_500) });
      expect(since).toContain("Since your last turn");
      expect(since).toContain("jump 9 → 12");
      expect(since).not.toContain("Added a dash");
      expect(yield* decisionsForTurn(root, { since: isoAt(3_000) })).toBeNull();
      // A session whose last turn began before this server did is told everything again.
      expect(yield* decisionsForTurn(root, { since: "2000-01-01T00:00:00.000Z" })).toContain(
        "Added a dash",
      );
      expect(yield* decidedKeys(root)).toEqual(["next:abc"]);
    }),
  ),
);

it.effect("puts the person's next message on the undo once, and a redo takes the undo back", () =>
  inGame((root) =>
    Effect.gen(function* () {
      yield* goOn(1_000);
      yield* recordDecision(root, {
        kind: "undone",
        text: "Undid Build 3: Added a dash on Shift.",
        build: "a".repeat(40),
        awaiting: true,
      });
      yield* goOn(2_000);
      // Their reason reaches the turn it is sent with, and is not news to that session after.
      yield* decisionsForTurn(root, { words: "The dash felt floaty. Make jumps higher." });
      yield* decisionsForTurn(root, { words: "Something else entirely." });
      const text = yield* fileText(root);
      expect(text).toContain(
        'Undid Build 3: Added a dash on Shift. Next message: "The dash felt floaty."',
      );
      expect(text).not.toContain("Something else");
      expect(yield* decisionsForTurn(root, { since: isoAt(1_500) })).toBeNull();
      expect(yield* dropDecisions(root, (each) => each.build === "a".repeat(40))).toBe(1);
      expect(yield* decisionsForTurn(root, {})).toBeNull();
    }),
  ),
);

it.effect("keeps a line written by hand and gives it to fresh sessions only", () =>
  inGame((root) =>
    Effect.gen(function* () {
      yield* goOn(1_000);
      yield* recordDecision(root, { kind: "note", text: "Note: no music with lyrics" });
      const path = NodePath.join(root, DECISIONS_FILE);
      yield* Effect.promise(async () =>
        NodeFSP.appendFile(path, "- Never add a timer\n<!-- a comment the person wrote -->\n"),
      );
      yield* goOn(2_000);
      yield* recordDecision(root, {
        kind: "kept-values",
        text: "Kept tuned values: a 1 → 2",
        build: "b".repeat(40),
      });
      yield* recordDecision(root, {
        kind: "kept-values",
        text: "Kept tuned values: a 1 → 3",
        build: "c".repeat(40),
        replaces: "b".repeat(40),
      });
      const text = yield* fileText(root);
      expect(text).toContain("- Never add a timer\n<!-- a comment the person wrote -->\n");
      expect(text).not.toContain("a 1 → 2");
      expect(yield* decisionsForTurn(root, {})).toContain("- Never add a timer");
      expect(yield* decisionsForTurn(root, { since: isoAt(500) })).not.toContain("timer");
    }),
  ),
);
