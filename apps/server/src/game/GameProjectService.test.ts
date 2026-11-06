// While a production run holds a game it is the folder's one writer, and a
// create must never delete a folder that is not a half-made create of ours.
// @effect-diagnostics nodeBuiltinImport:off -- The create's leftovers are real folders on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { admitDecision, gameFolderName, halfMadeCreate } from "./GameProjectService.ts";

const agent = (runRole: boolean) => ({ kind: "agent", runRole }) as const;
const client = { kind: "client" } as const;

describe("admitDecision", () => {
  it("lets only a role's own agent write a role's folder while the run is live", () => {
    for (const onRunFolder of [true, false]) {
      assert.isNull(admitDecision({ hold: "live", role: true, onRunFolder, caller: agent(true) }));
      // A person looking at the role's chat, on the game folder or the role's copy.
      assert.isNotNull(admitDecision({ hold: "live", role: true, onRunFolder, caller: client }));
      assert.isNotNull(
        admitDecision({ hold: "live", role: true, onRunFolder, caller: agent(false) }),
      );
    }
    // Once the run only finishes or restores, its roles have no work left in the folder.
    assert.isNotNull(
      admitDecision({ hold: "finishing", role: true, onRunFolder: true, caller: agent(true) }),
    );
  });

  it("refuses others only on the run's own folder, and an unreadable thread everywhere", () => {
    assert.isNotNull(
      admitDecision({ hold: "live", role: false, onRunFolder: true, caller: agent(false) }),
    );
    assert.isNull(admitDecision({ hold: "live", role: false, onRunFolder: false, caller: client }));
    assert.isNotNull(
      admitDecision({ hold: "live", role: "unknown", onRunFolder: false, caller: agent(true) }),
    );
    assert.isNull(admitDecision({ hold: null, role: true, onRunFolder: true, caller: client }));
  });
});

describe("game create", () => {
  it("reclaims only its own half-made folder", async () => {
    const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kurambit-create-"));
    try {
      const empty = NodePath.join(parent, "empty");
      NodeFS.mkdirSync(empty);
      assert.isTrue(await halfMadeCreate(empty));
      const marked = NodePath.join(parent, "marked");
      NodeFS.mkdirSync(NodePath.join(marked, "builds"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(marked, "builds/.kurambit-creating"), "");
      NodeFS.writeFileSync(NodePath.join(marked, "game.json"), "{}");
      assert.isTrue(await halfMadeCreate(marked));
      const someone = NodePath.join(parent, "someone");
      NodeFS.mkdirSync(NodePath.join(someone, "builds"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(someone, "notes.txt"), "mine");
      assert.isFalse(await halfMadeCreate(someone));
      assert.isFalse(await halfMadeCreate(NodePath.join(parent, "missing")));
    } finally {
      NodeFS.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("names a folder for any name", () => {
    assert.strictEqual(gameFolderName("Café Racer!", "abc123"), "cafe-racer");
    assert.strictEqual(gameFolderName("ゲーム", "abc123"), "game-abc123");
  });
});
