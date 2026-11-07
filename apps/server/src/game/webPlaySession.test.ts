// A browser game whose main thread hangs (an infinite loop is a common game
// bug) must read as a game that stopped answering, within the session's own
// bounds, never as a session that waits forever.
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- A real page on a real loopback server in a real headless Chromium, timed on the wall clock it hangs against.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { PlayUnresponsive } from "./playSession.ts";
import { openWebPlaySession } from "./webPlaySession.ts";

/** Playwright's headless shell, where this machine has one; the test skips without it. */
const headlessShell = (() => {
  const cache = NodePath.join(NodeOS.homedir(), ".cache/ms-playwright");
  const builds = NodeFS.existsSync(cache)
    ? NodeFS.readdirSync(cache).filter((name) => name.startsWith("chromium_headless_shell-"))
    : [];
  for (const build of builds.toSorted().toReversed()) {
    const binary = NodePath.join(
      cache,
      build,
      "chrome-headless-shell-linux64",
      "chrome-headless-shell",
    );
    if (NodeFS.existsSync(binary)) return binary;
  }
  return null;
})();

const HANGING_PAGE = `<!doctype html><script>
window.__studio = { ready: true, getState: () => ({ gameState: { alive: 1 } }) };
setTimeout(() => { for (;;) {} }, 500);
</script>`;

describe("web play session", () => {
  it.skipIf(headlessShell === null)(
    "reads a page whose main thread hangs as not answering, within its bounds",
    async () => {
      const server = NodeHttp.createServer((_request, response) => {
        response.setHeader("content-type", "text/html");
        response.end(HANGING_PAGE);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;
      try {
        const session = await openWebPlaySession({
          browser: {
            executable: headlessShell!,
            sandbox: false,
            launchFailure: async (cause) => String(cause),
            args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
            renderer: null,
            software: true,
            probe: "",
          },
          url: `http://127.0.0.1:${port}/`,
          width: 320,
          height: 240,
          bootTimeoutMs: 20_000,
        });
        await session.realtime({ fps: 12, width: 320, onFrame: () => undefined });
        await new Promise((resolve) => setTimeout(resolve, 800));
        const started = Date.now();
        expect((await session.nextTick(1_000)).kind).toBe("timeout");
        expect(Date.now() - started).toBeLessThan(3_000);
        await expect(session.act([{ waitMs: 100 }], null)).rejects.toBeInstanceOf(PlayUnresponsive);
        await session.input({ held: ["d"], taps: [], clicks: [] });
        // Both the bot loop and its launch close the session: neither may
        // surface a raw "Target closed" from a page our own bound gave up on.
        await session.close();
        await session.close();
        expect(Date.now() - started).toBeLessThan(60_000);
      } finally {
        server.close();
      }
    },
    90_000,
  );
});
