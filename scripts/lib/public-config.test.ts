// @effect-diagnostics nodeBuiltinImport:off - exercises real .env files on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { loadRepoEnv } from "./public-config.ts";
it("keeps .env precedence and ignores inherited hosted configuration", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "game-studio-env-"));
  try {
    NodeFS.writeFileSync(
      NodePath.join(root, ".env"),
      "GAME_STUDIO_HOME=root\nOPENAI_API_KEY=provider-root\nT3CODE_RELAY_URL=ignored\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(root, ".env.local"),
      "GAME_STUDIO_HOME=local\nVITE_CLERK_PUBLISHABLE_KEY=ignored\n",
    );
    const env = loadRepoEnv({
      repoRoot: root,
      baseEnv: { GAME_STUDIO_HOME: "process", T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "ignored" },
    });
    expect(env.GAME_STUDIO_HOME).toBe("process");
    expect(env.OPENAI_API_KEY).toBe("provider-root");
    expect(Object.keys(env).some((key) => /CLERK|RELAY/.test(key))).toBe(false);
  } finally {
    NodeFS.rmSync(root, { recursive: true });
  }
});
