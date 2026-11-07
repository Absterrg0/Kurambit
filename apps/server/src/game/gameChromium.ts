import * as HostProcess from "@kurambit/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { GameOperationError } from "@kurambit/contracts";
import { resolveRootCliCommand } from "../cli/invocation.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as PreviewBrowserHost from "../preview/PreviewBrowserHost.ts";
import { chromiumChildEnv } from "./gameWebServer.ts";

export interface GameBrowser {
  readonly executable: string;
  /** Chrome's sandbox, on unless the operator turned it off (KURAMBIT_SERVER_BROWSER_SANDBOX=0). */
  readonly sandbox: boolean;
  /**
   * Why the browser would not start, for the creator: what on this host
   * stopped it when that is known, else the launch error and what to try.
   */
  readonly launchFailure: (cause: unknown) => Promise<string>;
  /** Every launch's arguments, with the render backend this machine was probed for. */
  readonly args: ReadonlyArray<string>;
  /** WebGL's renderer string the browser draws with; null when the probe could not read it. */
  readonly renderer: string | null;
  /** The browser draws on the CPU (SwiftShader): play speed then says nothing about the game. */
  readonly software: boolean;
  /** What each GPU backend the probe tried printed, in a line: why it chose this one. */
  readonly probe: string;
}

const BASE_ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--mute-audio",
  "--hide-scrollbars",
  "--disable-dev-shm-usage",
] as const;
/** Chrome's own CPU renderer: works everywhere, and costs several cores on a 3D scene. */
const SOFTWARE_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] as const;

/**
 * The hardware backends tried on Linux, in order: EGL on the GPU's render
 * node, then Vulkan. Neither needs a display. Elsewhere Chrome's default
 * already draws on the GPU, so it is only probed for its renderer.
 */
export const backendCandidates = (
  platform: NodeJS.Platform,
): ReadonlyArray<ReadonlyArray<string>> =>
  platform === "linux"
    ? [["--use-angle=gl-egl"], ["--use-angle=vulkan", "--enable-features=Vulkan"]]
    : [[]];

/** The renderer line the probe page prints in the dumped DOM; null when it printed none or no WebGL. */
export const parseProbeRenderer = (dom: string): string | null => {
  const found = /RENDERER=([^<\n]+)/.exec(dom)?.[1]?.trim();
  return found === undefined || found === "" || found === "no-webgl" ? null : found;
};

/** A renderer that draws on the CPU. */
export const isSoftwareRenderer = (renderer: string): boolean =>
  /swiftshader|llvmpipe|softpipe|software/i.test(renderer);

export interface RenderBackend {
  readonly args: ReadonlyArray<string>;
  readonly renderer: string | null;
  readonly software: boolean;
}

/** The probe's output, one clause per backend tried: what it printed, or that it printed nothing. */
export const describeProbe = (
  probed: ReadonlyArray<{ readonly args: ReadonlyArray<string>; readonly dom: string }>,
): string =>
  probed.length === 0
    ? "no backend was tried"
    : probed
        .map(({ args, dom }) => {
          const name = args.find((arg) => arg.startsWith("--use-angle="))?.slice(12) ?? "default";
          const printed = /RENDERER=([^<\n]+)/.exec(dom)?.[1]?.trim();
          return `${name}: ${
            printed !== undefined
              ? `RENDERER=${printed.slice(0, 120)}`
              : dom.trim() === ""
                ? "printed nothing"
                : `printed no renderer (${dom.replace(/\s+/g, " ").trim().slice(0, 80)})`
          }`;
        })
        .join("; ");

/**
 * The first candidate that drew on hardware; else Chrome's CPU renderer. Off
 * Linux the default is kept whatever it reports, with its renderer recorded.
 */
export const chooseBackend = (
  platform: NodeJS.Platform,
  probed: ReadonlyArray<{ readonly args: ReadonlyArray<string>; readonly renderer: string | null }>,
): RenderBackend => {
  const hardware = probed.find(
    (each) => each.renderer !== null && !isSoftwareRenderer(each.renderer),
  );
  if (hardware !== undefined)
    return { args: hardware.args, renderer: hardware.renderer, software: false };
  if (platform !== "linux") {
    const renderer = probed[0]?.renderer ?? null;
    return { args: [], renderer, software: renderer !== null && isSoftwareRenderer(renderer) };
  }
  return { args: SOFTWARE_ARGS, renderer: null, software: true };
};

// encodeURIComponent leaves ' raw, and headless Chromium then never runs the page: every game
// browser would fall back to software rendering.
const PROBE_PAGE = `data:text/html,${encodeURIComponent(
  "<!doctype html><body><script>const c=document.createElement('canvas');const gl=c.getContext('webgl2')||c.getContext('webgl');let r='no-webgl';if(gl){const e=gl.getExtension('WEBGL_debug_renderer_info');r=e?gl.getParameter(e.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);}document.body.textContent='RENDERER='+r;</script></body>",
).replaceAll("'", "%27")}`;
const PROBE_TIMEOUT = "15 seconds" as const;

/**
 * Once per server process and browser: the backend every game browser
 * launches with. Each candidate draws one WebGL canvas in the same headless
 * shell, with no display in its environment; one that fails or hangs counts
 * as no hardware. Shared by every service that makes a game browser.
 */
const backends = new Map<string, Promise<RenderBackend & { readonly probe: string }>>();
const probeBackend = (executable: string, sandbox: boolean) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const platform = yield* HostProcess.Platform;
    const env = chromiumChildEnv();
    delete env.DISPLAY;
    delete env.WAYLAND_DISPLAY;
    const probed = [];
    const printed = [];
    for (const args of backendCandidates(platform)) {
      const dom = yield* spawner
        .string(
          ChildProcess.make(
            executable,
            [
              ...BASE_ARGS,
              ...args,
              "--headless",
              ...(sandbox ? [] : ["--no-sandbox"]),
              "--dump-dom",
              PROBE_PAGE,
            ],
            { env, extendEnv: false, stdin: "ignore", stderr: "ignore" },
          ),
        )
        .pipe(
          Effect.timeout(PROBE_TIMEOUT),
          Effect.orElseSucceed(() => ""),
        );
      const renderer = parseProbeRenderer(dom);
      probed.push({ args, renderer });
      printed.push({ args, dom });
      if (renderer !== null && !isSoftwareRenderer(renderer)) break;
    }
    const chosen = chooseBackend(platform, probed);
    const probe = describeProbe(printed);
    yield* chosen.software
      ? Effect.logInfo("Game browsers render in software: no GPU backend drew.", { probe })
      : Effect.logInfo("Game browsers render on the GPU.", { renderer: chosen.renderer });
    return { ...chosen, probe };
  });

/**
 * Kurambit's own headless browser for game pages: T3's pinned, verified
 * headless shell (PreviewBrowser), installed on first use, so a three.js game
 * needs nothing installed on the machine. Built once per service; the result
 * asks for it per launch. A browser that cannot be had is the machine's
 * problem, never the game's: an install in progress is `busy` (its cause is
 * the PreviewBrowserInstallingError), and a failed install or an unsupported
 * platform is `tool-missing`.
 */
export const makeGameBrowser = Effect.gen(function* () {
  const preview = yield* PreviewBrowser.PreviewBrowser;
  const services = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
  const platform = yield* HostProcess.Platform;
  const setupCommand = yield* resolveRootCliCommand(PreviewBrowserHost.SETUP_SUBCOMMAND);
  const sandbox = !PreviewBrowserHost.sandboxDisabled(yield* HostProcess.Environment);
  const launchFailure = async (executable: string, cause: unknown): Promise<string> => {
    // Playwright's launch error drops Chrome's own output; its sandbox note survives.
    const diagnosed = await Effect.runPromiseWith(services)(
      PreviewBrowserHost.diagnoseLaunchFailure({
        executable,
        setupCommand,
        output: /sandboxing failed/i.test(String(cause))
          ? PreviewBrowserHost.NO_SANDBOX_SIGNATURE
          : "",
      }),
    ).catch(() => undefined);
    if (diagnosed?._tag === "PreviewBrowserSandboxError")
      return `${diagnosed.message} Or start Kurambit with KURAMBIT_SERVER_BROWSER_SANDBOX=0 to run it without the sandbox.`;
    if (diagnosed !== undefined) return diagnosed.message;
    const first = (cause instanceof Error ? cause.message : String(cause)).split("\n")[0] ?? "";
    return `Kurambit's headless browser would not start (${first.slice(0, 120)}).${
      sandbox
        ? ` If this host blocks Chrome's sandbox, run \`${setupCommand}\` once, or start Kurambit with KURAMBIT_SERVER_BROWSER_SANDBOX=0.`
        : ""
    }`;
  };
  return (operation: string, path: string): Effect.Effect<GameBrowser, GameOperationError> =>
    preview.executable.pipe(
      Effect.mapError(
        (error) =>
          new GameOperationError({
            operation,
            path,
            reason: error._tag === "PreviewBrowserInstallingError" ? "busy" : "tool-missing",
            detail: error.message,
            cause: error,
          }),
      ),
      Effect.flatMap((executable) => {
        let backend = backends.get(executable);
        if (backend === undefined) {
          backend = Effect.runPromiseWith(services)(
            probeBackend(executable, sandbox).pipe(
              Effect.provideService(HostProcess.Platform, platform),
              Effect.catchCause((cause) =>
                Effect.logInfo("Game browsers render in software: the GPU probe failed.", {
                  cause,
                }).pipe(
                  Effect.as({
                    ...chooseBackend(platform, []),
                    probe: `the probe itself failed (${String(Cause.squash(cause)).slice(0, 120)})`,
                  }),
                ),
              ),
            ),
          );
          backends.set(executable, backend);
        }
        return Effect.map(
          Effect.promise(() => backend),
          (chosen) => ({
            executable,
            sandbox,
            launchFailure: (cause: unknown) => launchFailure(executable, cause),
            args: [...BASE_ARGS, ...chosen.args],
            renderer: chosen.renderer,
            software: chosen.software,
            probe: chosen.probe,
          }),
        );
      }),
    );
});

/**
 * The `window.__studio` probe every three.js game ships. Reads the ready
 * flag: true once the first frame rendered. Null when the bridge is missing.
 */
export const READ_STUDIO_READY = `(() => {
  const studio = window.__studio;
  if (studio === null || typeof studio !== "object") return null;
  return studio.ready === true;
})()`;

/** Reads `window.__studio.getState()`; null when the bridge is missing or throws. */
export const READ_STUDIO_STATE = `(() => {
  const studio = window.__studio;
  if (studio === null || typeof studio !== "object") return null;
  if (typeof studio.getState !== "function") return null;
  try {
    return JSON.stringify(studio.getState());
  } catch {
    return null;
  }
})()`;

/** Reads `window.__studio.perf()` (the shell's play stats) as JSON; null when the shell has none. */
export const READ_STUDIO_PERF = `(() => {
  const studio = window.__studio;
  if (studio === null || typeof studio !== "object" || typeof studio.perf !== "function") return null;
  try {
    return JSON.stringify(studio.perf());
  } catch {
    return null;
  }
})()`;

/**
 * Reaches named late content through the game's own setState. Function text,
 * not a call: the caller applies it to one JSON input. Returns the game's
 * boolean: a refusal is not an error.
 */
export const STUDIO_SET_STATE = `(input) => {
  const target = input?.target;
  const values = input?.values ?? {};
  const studio = window.__studio;
  if (studio === null || typeof studio !== "object") return false;
  if (typeof studio.setState !== "function") return false;
  try {
    return studio.setState(target, values) === true;
  } catch {
    return false;
  }
}`;

/** The route vocabulary uses "Space"; Playwright and DOM key values want " ". */
export const toPlaywrightKey = (key: string): string => (key === "Space" ? " " : key);

/** Maps a page error's stack URL back to the game file it came from. */
export const stackToGameFile = (stack: string | undefined, origin: string): string => {
  if (stack === undefined || stack === "") return "web/main.js";
  const match = new RegExp(`${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([^:),\\s]+)`).exec(
    stack,
  );
  return match?.[1] === undefined ? "web/main.js" : `web/${match[1]}`;
};
