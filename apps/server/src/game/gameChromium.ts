// @effect-diagnostics nodeBuiltinImport:off -- The play lane's width follows the machine's cores, which only node:os reports.
import * as HostProcess from "@kurambit/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeOS from "node:os";
import { GameOperationError } from "@kurambit/contracts";
import { resolveRootCliCommand } from "../cli/invocation.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as PreviewBrowserHost from "../preview/PreviewBrowserHost.ts";
import { engineChildEnv } from "./GameProcesses.ts";
import { RUNTIME_ROUTE } from "./gameRuntime.ts";
import { playLane } from "./playLane.ts";

/**
 * A clean room for Chromium and its children: the allowlisted engine base
 * plus the heap knob, and nothing else. No desktop
 * display leaks in (headless runs own no DISPLAY), and page JS stays
 * sandboxed with no environment to read; only the utility processes that
 * launch the browser see this.
 */
export const chromiumChildEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...engineChildEnv() };
  env.NODE_OPTIONS = "--max-old-space-size=1536";
  return env;
};

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
/**
 * Chrome's own CPU renderer: works everywhere, and costs several cores on a 3D scene. WebGL draws
 * in SwiftShader either way; the compositor raster in Skia instead, because compositing a lit
 * game's canvas through SwiftShader made every screenshot wait 10 to 40 s and every browser close
 * 13 to 27 s (Round 7A), while the game's own frame rate stayed the same.
 */
const SOFTWARE_ARGS = [
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--disable-gpu-compositing",
] as const;

/**
 * Mesa's CPU renderer behind EGL, which Chrome's GPU blocklist refuses: it plays a lit scene
 * several times faster than SwiftShader on the same cores (the QA play of a 200k-triangle kart
 * game in 26-66 s against 203 s), so a machine with no GPU but Mesa draws with it. Never taken
 * for a GPU: the blocklist stays on for hardware.
 */
const LLVMPIPE_ARGS = ["--use-angle=gl-egl", "--ignore-gpu-blocklist"] as const;
const isLlvmpipe = (renderer: string | null) => renderer !== null && /llvmpipe/i.test(renderer);

/**
 * The backends tried on Linux, in order: EGL on the GPU's render node, then
 * Vulkan, then Mesa's CPU renderer. None needs a display. Elsewhere Chrome's
 * default already draws on the GPU, so it is only probed for its renderer.
 */
export const backendCandidates = (
  platform: NodeJS.Platform,
): ReadonlyArray<ReadonlyArray<string>> =>
  platform === "linux"
    ? [["--use-angle=gl-egl"], ["--use-angle=vulkan", "--enable-features=Vulkan"], LLVMPIPE_ARGS]
    : [[]];

/** The renderer line the probe page prints in the dumped DOM; null when it printed none or no WebGL. */
export const parseProbeRenderer = (dom: string): string | null => {
  const found = /RENDERER=([^<\n]+)/.exec(dom)?.[1]?.trim();
  return found === undefined || found === "" || found === "no-webgl" ? null : found;
};

/** A renderer that draws on the CPU. */
const isSoftwareRenderer = (renderer: string): boolean =>
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
 * The first candidate that drew on hardware; else Mesa's CPU renderer; else
 * Chrome's. Off Linux the default is kept whatever it reports, with its
 * renderer recorded.
 */
export const chooseBackend = (
  platform: NodeJS.Platform,
  probed: ReadonlyArray<{ readonly args: ReadonlyArray<string>; readonly renderer: string | null }>,
): RenderBackend => {
  const hardware = probed.find(
    (each) =>
      each.args !== LLVMPIPE_ARGS && each.renderer !== null && !isSoftwareRenderer(each.renderer),
  );
  if (hardware !== undefined)
    return { args: hardware.args, renderer: hardware.renderer, software: false };
  if (platform !== "linux") {
    const renderer = probed[0]?.renderer ?? null;
    return { args: [], renderer, software: renderer !== null && isSoftwareRenderer(renderer) };
  }
  const mesa = probed.find((each) => each.args === LLVMPIPE_ARGS && isLlvmpipe(each.renderer));
  if (mesa !== undefined) return { args: mesa.args, renderer: mesa.renderer, software: true };
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
/**
 * Whether this machine's game browsers draw in software, once a probe in this process settled;
 * null before. The turn rules read it to tell the agent once (gameTurnRules.ts): with no GPU for
 * the headless browser there is none for the person's Stage on the same machine either.
 */
let drawsInSoftware: boolean | null = null;
export const gameBrowsersDrawInSoftware = () => drawsInSoftware;
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
  const backendFor = (executable: string) => {
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
          // In software no frame time is read, so plays share the cores: each SwiftShader
          // page draws on several threads, so a quarter of them per play. On a GPU, one.
          Effect.tap((chosen) =>
            playLane.setWidth(chosen.software ? NodeOS.availableParallelism() / 4 : 1),
          ),
        ),
      ).then((chosen) => {
        drawsInSoftware = chosen.software;
        return chosen;
      });
      backends.set(executable, backend);
    }
    return backend;
  };
  const browserFor = (
    operation: string,
    path: string,
  ): Effect.Effect<GameBrowser, GameOperationError> =>
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
        const backend = backendFor(executable);
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
  return Object.assign(browserFor, {
    /**
     * Probes an installed browser's backend now, so the first turn's rules can say whether this
     * machine draws in software; installs nothing.
     */
    probeInstalled: preview.installed.pipe(
      Effect.flatMap((installed) =>
        Option.isSome(installed)
          ? Effect.promise(() => backendFor(installed.value)).pipe(Effect.asVoid)
          : Effect.void,
      ),
    ),
  });
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

/**
 * Maps a page error's stack URL back to the game file it came from: the first frame in the
 * game's own files, past Kurambit's runtime (which the game does not hold).
 */
export const stackToGameFile = (stack: string | undefined, origin: string): string => {
  if (stack === undefined || stack === "") return "web/main.js";
  const frames = stack.matchAll(
    new RegExp(`${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([^:),\\s]+)`, "g"),
  );
  for (const [, file] of frames)
    if (file !== undefined && !file.startsWith(`${RUNTIME_ROUTE}/`)) return `web/${file}`;
  return "web/main.js";
};
