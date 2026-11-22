import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { parseKurambitProjectFile, KurambitProjectFileFromJson } from "./kurambitProjectFile.ts";

const decodeJson = Schema.decodeUnknownSync(KurambitProjectFileFromJson);

describe("KurambitProjectFileFromJson", () => {
  it("decodes lenient JSONC with comments and trailing commas", () => {
    const decoded = decodeJson(`{
      // team scripts
      "iconPath": "assets/logo.svg",
      "scripts": [
        { "name": "Dev", "command": "pnpm dev", },
      ],
    }`);

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ name: "Dev", command: "pnpm dev" });
  });

  it("fails on malformed JSON", () => {
    expect(() => decodeJson("{ not json")).toThrow();
  });
});

describe("parseKurambitProjectFile", () => {
  it("returns the decoded file for valid contents", () => {
    expect(parseKurambitProjectFile('{ "defaultThreadEnvMode": "worktree" }')).toEqual({
      defaultThreadEnvMode: "worktree",
    });
  });

  it("returns null for malformed or invalid contents", () => {
    expect(parseKurambitProjectFile("{ not json")).toBeNull();
    expect(parseKurambitProjectFile('{ "defaultThreadEnvMode": "spaceship" }')).toBeNull();
  });
});
