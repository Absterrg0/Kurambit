#!/usr/bin/env node
// Studio `blender`: Blender + mcp-for-blender on a private Xvfb display.
// One UI Blender per game, addon installed into an isolated config dir,
// MCP server auto-started on a per-game localhost port. Software GL only.
// Never touches ~/.config/blender or the user's desktop: DISPLAY routes are
// stripped from this process, Blender runs only on the private display.
// Ref: ahujasid/mcp-for-blender (MIT), ~/.gs-tmp/ref-blendermcp/repo.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const here = NodeURL.fileURLToPath(import.meta.url);
const REF_ADDON = "/home/abstergo/.gs-tmp/ref-blendermcp/repo/src/blender_mcp/bundled/addon.py";
const PINNED_PKG = "mcp-for-blender@2.2.6";
const BLENDER = NodePath.join(
  process.env.XDG_DATA_HOME ?? NodePath.join(NodeOS.homedir(), ".local/share"),
  "game-studio/tools/blender-4.5.14/blender",
);
const DISPLAY_VARS = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"] as const;
for (const name of DISPLAY_VARS) delete process.env[name];

const out = (value: unknown): void => console.log(JSON.stringify(value));
const fail = (error: string): never => {
  out({ ok: false, error });
  process.exit(1);
};

const homeFor = (gameDir: string): string => NodePath.join(gameDir, "builds", "logs", "blender");
const sessionPath = (gameDir: string): string => NodePath.join(homeFor(gameDir), "session.json");

/** Blender never sees the real HOME/config: everything lives under the game. */
const blenderEnv = (
  gameDir: string,
  display: string | null,
  extra?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const home = homeFor(gameDir);
  const fakeHome = NodePath.join(home, "home");
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const name of DISPLAY_VARS) delete env[name];
  env.HOME = fakeHome;
  env.XDG_CONFIG_HOME = NodePath.join(fakeHome, ".config");
  env.XDG_CACHE_HOME = NodePath.join(fakeHome, ".cache");
  env.XDG_DATA_HOME = NodePath.join(fakeHome, ".local", "share");
  env.XDG_RUNTIME_DIR = NodePath.join(home, "runtime");
  env.TMPDIR = NodePath.join(NodeOS.homedir(), ".gs-tmp");
  env.LIBGL_ALWAYS_SOFTWARE = "1";
  env.LP_NUM_THREADS = "2";
  env.DISABLE_TELEMETRY = "true";
  const lib = NodePath.join(NodeOS.homedir(), ".gs-tmp/xvfb-local/usr/lib/x86_64-linux-gnu");
  env.LD_LIBRARY_PATH = `${lib}${NodePath.delimiter}${process.env.LD_LIBRARY_PATH ?? ""}`;
  env.PATH = `${NodePath.join(NodeOS.homedir(), ".gs-tmp/xvfb-local/usr/bin")}${NodePath.delimiter}${env.PATH ?? ""}`;
  if (display !== null) env.DISPLAY = display;
  return env;
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const portFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = NodeNet.connect(port, "127.0.0.1");
    s.once("connect", () => {
      s.destroy();
      resolve(false);
    });
    s.once("error", () => {
      s.destroy();
      resolve(true);
    });
  });

const portFor = (gameDir: string): number => {
  const h = NodeCrypto.createHash("sha1").update(NodePath.resolve(gameDir)).digest();
  return 19100 + (h.readUInt16BE(0) % 700);
};

const pickDisplay = async (): Promise<number | null> => {
  for (let n = 119; n < 250; n++) {
    try {
      await NodeFSP.access(`/tmp/.X${n}-lock`);
      continue;
    } catch {
      /* candidate */
    }
    const taken = await new Promise<boolean>((resolve) => {
      const s = NodeNet.connect(6000 + n, "127.0.0.1");
      s.once("connect", () => {
        s.destroy();
        resolve(true);
      });
      s.once("error", () => {
        s.destroy();
        resolve(false);
      });
    });
    if (!taken) return n;
  }
  return null;
};

const waitPort = async (port: number, timeoutMs: number): Promise<boolean> => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!(await portFree(port))) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
};

const start = async (gameDir: string, portOpt?: number): Promise<void> => {
  const home = homeFor(gameDir);
  const existing = await NodeFSP.readFile(sessionPath(gameDir), "utf8")
    .then((t) => JSON.parse(t) as { blenderPid?: number; ready?: boolean })
    .catch(() => null);
  if (existing?.ready && typeof existing.blenderPid === "number" && alive(existing.blenderPid))
    fail("A blender session is already running; `blender stop` first.");
  await NodeFSP.mkdir(home, { recursive: true });
  await NodeFSP.mkdir(NodePath.join(home, "home", ".config"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(home, "runtime"), { recursive: true, mode: 0o700 });
  const port = portOpt ?? portFor(gameDir);
  if (!(await portFree(port))) fail(`Port ${port} is taken; pass --port another.`);
  // Install the addon file into the isolated config (never the real one).
  const addonsDir = NodePath.join(home, "home", ".config", "blender", "4.5", "scripts", "addons");
  await NodeFSP.mkdir(addonsDir, { recursive: true });
  await NodeFSP.copyFile(REF_ADDON, NodePath.join(addonsDir, "blender_mcp_studio.py"));
  // Enable the addon in the isolated prefs with a background Blender.
  const enablePy = NodePath.join(home, "enable_addon.py");
  await NodeFSP.writeFile(
    enablePy,
    `import bpy\nbpy.ops.preferences.addon_enable(module='blender_mcp_studio')\nbpy.ops.wm.save_userpref()\nprint("STUDIO_BLENDER_ADDON_ENABLED")\n`,
  );
  const enable = NodeChildProcess.spawnSync(BLENDER, ["--background", "--python", enablePy], {
    env: blenderEnv(gameDir, null),
    timeout: 120_000,
    encoding: "utf8",
  });
  if (!`${enable.stdout ?? ""}${enable.stderr ?? ""}`.includes("STUDIO_BLENDER_ADDON_ENABLED"))
    fail(
      `Could not enable the addon: ${`${enable.stdout ?? ""}${enable.stderr ?? ""}`.slice(-600)}`,
    );
  // UI Blender on a private display with the MCP server auto-started.
  const displayNum = await pickDisplay();
  if (displayNum === null) fail("No free Xvfb display.");
  const display = `:${displayNum}`;
  const pathEnv = blenderEnv(gameDir, display).PATH ?? "";
  const findExe = (name: string): string | null => {
    for (const dir of pathEnv.split(NodePath.delimiter)) {
      try {
        NodeChildProcess.execFileSync("test", ["-x", NodePath.join(dir, name)]);
        return NodePath.join(dir, name);
      } catch {
        /* next */
      }
    }
    return null;
  };
  const xvfbBin = findExe("Xvfb") ?? "Xvfb";
  const xvfb = NodeChildProcess.spawn(xvfbBin, [display, "-screen", "0", "1280x800x24"], {
    env: blenderEnv(gameDir, null),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const seenAt = Date.now();
  for (;;) {
    try {
      await NodeFSP.access(`/tmp/.X11-unix/X${displayNum}`);
      break;
    } catch {
      /* not up */
    }
    if (xvfb.exitCode !== null || Date.now() - seenAt > 15_000) fail("Xvfb did not start.");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const bootPy = NodePath.join(home, "boot_server.py");
  await NodeFSP.writeFile(
    bootPy,
    `import bpy\nbpy.ops.preferences.addon_enable(module='blender_mcp_studio')\n` +
      `scene = bpy.context.scene\nscene.blendermcp_port = ${port}\n` +
      `scene.blendermcp_auto_start_server = True\nbpy.ops.blendermcp.start_server()\n` +
      `print("STUDIO_BLENDER_READY port=${port}")\n`,
  );
  const logFd = await NodeFSP.open(NodePath.join(home, "blender.log"), "w");
  const child = NodeChildProcess.spawn(BLENDER, ["--python", bootPy], {
    env: blenderEnv(gameDir, display),
    detached: true,
    stdio: ["ignore", logFd.fd, logFd.fd],
  });
  await logFd.close().catch(() => undefined);
  child.unref();
  const up = await waitPort(port, 90_000);
  if (!up)
    fail(
      "Blender's MCP server did not open its port in time; see builds/logs/blender/blender.log.",
    );
  await NodeFSP.writeFile(
    sessionPath(gameDir),
    JSON.stringify({
      ready: true,
      blenderPid: child.pid,
      xvfbPid: xvfb.pid,
      display,
      port,
      pkg: PINNED_PKG,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }),
  );
  out({
    ok: true,
    display,
    port,
    blenderPid: child.pid,
    xvfbPid: xvfb.pid ?? null,
    pkg: PINNED_PKG,
  });
};

const stop = async (gameDir: string): Promise<void> => {
  const session = await NodeFSP.readFile(sessionPath(gameDir), "utf8")
    .then((t) => JSON.parse(t) as { blenderPid?: number; xvfbPid?: number })
    .catch(() => null);
  if (!session) {
    out({ ok: true, stopped: true, note: "no session file" });
    return;
  }
  // Only recorded PIDs are ever signalled, never a name or pattern.
  for (const pid of [session.blenderPid, session.xvfbPid]) {
    if (typeof pid !== "number" || pid <= 0 || !alive(pid)) continue;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* gone */
      }
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
  for (const pid of [session.blenderPid, session.xvfbPid]) {
    if (typeof pid !== "number" || pid <= 0 || !alive(pid)) continue;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
  await NodeFSP.rm(sessionPath(gameDir), { force: true });
  out({ ok: true, stopped: true });
};

const sessionFor = async (gameDir: string): Promise<{ port: number }> => {
  const session = await NodeFSP.readFile(sessionPath(gameDir), "utf8")
    .then((t) => JSON.parse(t) as { port?: number; blenderPid?: number })
    .catch(() => null);
  if (!session || typeof session.port !== "number")
    fail("No Blender session is running; `blender start` first.");
  if (typeof session.blenderPid === "number" && !alive(session.blenderPid))
    fail("The recorded Blender PID is gone; `blender stop` then `blender start`.");
  return { port: (session as { port: number }).port };
};

/** Talk straight to the addon's localhost socket: no MCP client in between.
 *  Request {"type","params"}; the addon answers with one JSON object
 *  {"status":"success","result":...} (reads until it parses; renders and big
 *  scenes arrive in chunks). Only the recorded session port is ever dialled. */
const callAddon = (
  port: number,
  type: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const socket = NodeNet.connect(port, "127.0.0.1");
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(`Blender did not answer '${type}' within ${Math.round(timeoutMs / 1000)}s.`),
      );
    }, timeoutMs);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Blender socket: ${error.message}`));
    });
    socket.once("connect", () => {
      socket.write(JSON.stringify({ type, params }));
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.length > 256 * 1024 * 1024) {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error("Blender answer exceeded 256 MiB."));
        return;
      }
      try {
        const answer = JSON.parse(buffer) as {
          status?: string;
          result?: unknown;
          message?: string;
        };
        clearTimeout(timer);
        socket.destroy();
        if (answer.status !== "success") resolve({ __error: answer.message ?? answer });
        else resolve(answer.result);
        return;
      } catch {
        /* incomplete; keep reading */
      }
    });
  });

const unwrap = (answer: unknown): unknown => {
  const record = answer as { __error?: unknown };
  if (record && typeof record === "object" && "__error" in record)
    fail(
      `Blender: ${typeof record.__error === "string" ? record.__error : JSON.stringify(record.__error).slice(0, 1000)}`,
    );
  return answer;
};

const cmdExec = async (gameDir: string, file: string): Promise<void> => {
  if (!file) fail("Usage: blender exec <file.py> [--dir GAME].");
  const code = await NodeFSP.readFile(NodePath.resolve(file), "utf8").catch(() => null);
  if (code === null) fail(`Cannot read ${file}.`);
  const { port } = await sessionFor(gameDir);
  const answer = unwrap(await callAddon(port, "execute_code", { code }, 600_000)) as {
    executed?: boolean;
    result?: unknown;
  };
  const text = typeof answer?.result === "string" ? answer.result : JSON.stringify(answer, null, 2);
  if (text) console.log(text);
  out({ ok: true, executed: answer?.executed === true, chars: text.length });
};

const RENDER_FALLBACK = (filepath: string): string => `
import bpy
fp = ${JSON.stringify(filepath)}
scene = bpy.context.scene
scene.render.image_settings.file_format = 'PNG'
scene.render.resolution_x = 960
scene.render.resolution_y = 540
scene.render.resolution_percentage = 100
scene.render.film_transparent = False
# Software-GL-safe engine: Workbench never needs a GPU context.
try:
    scene.render.engine = 'BLENDER_WORKBENCH'
except Exception:
    pass
cam = scene.camera
if cam is None:
    cams = [o for o in scene.objects if o.type == 'CAMERA']
    if cams:
        cam = cams[0]
        scene.camera = cam
if cam is None:
    bpy.ops.object.camera_add(location=(6, -6, 4))
    cam = bpy.context.object
    cam.data.lens = 35
    track = cam.constraints.new(type='TRACK_TO')
    if not scene.objects.get('STUDIO_FOCUS'):
        bpy.ops.object.empty_add(location=(0, 0, 1))
        bpy.context.object.name = 'STUDIO_FOCUS'
    track.target = scene.objects['STUDIO_FOCUS']
    track.track_axis = 'TRACK_NEGATIVE_Z'
    track.up_axis = 'UP_Y'
    scene.camera = cam
if not any(o.type == 'LIGHT' for o in scene.objects):
    bpy.ops.object.light_add(type='SUN', location=(4, -3, 8))
scene.render.filepath = fp
bpy.ops.render.render(write_still=True)
print("STUDIO_RENDER_OK " + fp)
`;

const cmdCapture = async (gameDir: string, dest: string): Promise<void> => {
  if (!dest) fail("Usage: blender capture <out.png> [--dir GAME].");
  const absolute = NodePath.resolve(dest);
  await NodeFSP.mkdir(NodePath.dirname(absolute), { recursive: true });
  const { port } = await sessionFor(gameDir);
  // 1) Viewport capture (offscreen under software GL; window grab fallback).
  const shot = await callAddon(
    port,
    "get_viewport_screenshot",
    { filepath: absolute, max_size: 1280 },
    300_000,
  ).catch((error: Error) => ({ error: error.message }));
  const good = async (): Promise<boolean> => {
    try {
      return (await NodeFSP.stat(absolute)).size > 1000;
    } catch {
      return false;
    }
  };
  if (shot && typeof shot === "object" && !("error" in (shot as object)) && (await good())) {
    out({ ok: true, path: absolute, method: (shot as { method?: string }).method ?? "viewport" });
    return;
  }
  // 2) Fallback: a real render with the scene camera (or a fresh 3/4 camera).
  const rendered = unwrap(
    await callAddon(port, "execute_code", { code: RENDER_FALLBACK(absolute) }, 600_000),
  ) as { result?: unknown };
  if (
    !`${(rendered as { result?: string }).result ?? ""}`.includes("STUDIO_RENDER_OK") ||
    !(await good())
  )
    fail(`Render fallback produced no image at ${absolute}.`);
  out({ ok: true, path: absolute, method: "render-fallback" });
};

const cmdScene = async (gameDir: string): Promise<void> => {
  const { port } = await sessionFor(gameDir);
  const info = unwrap(await callAddon(port, "get_scene_info", {}, 120_000)) as {
    objects?: Array<{ name?: string; type?: string }>;
    [key: string]: unknown;
  };
  const detail = unwrap(
    await callAddon(
      port,
      "execute_code",
      {
        code: [
          "import bpy, json",
          "print(json.dumps({",
          "  \"armatures\": [o.name for o in bpy.data.objects if o.type == 'ARMATURE'],",
          '  "actions": [a.name for a in bpy.data.actions],',
          '  "meshes": [m.name for m in bpy.data.meshes],',
          '  "collections": [c.name for c in bpy.data.collections],',
          "}))",
        ].join("\n"),
      },
      120_000,
    ),
  ) as { result?: string };
  let extra: Record<string, string[]> = {};
  try {
    extra = JSON.parse(
      `${detail?.result ?? "{}"}`
        .split("\n")
        .filter((l) => l.trim().startsWith("{"))
        .join("\n") || "{}",
    ) as Record<string, string[]>;
  } catch {
    /* keep empty */
  }
  const objects = Array.isArray(info?.objects) ? info.objects : [];
  const byType: Record<string, string[]> = {};
  for (const o of objects) {
    const type = `${o?.type ?? "?"}`;
    (byType[type] ??= []).push(`${o?.name ?? "?"}`);
  }
  const lines = [`${objects.length} object(s):`];
  for (const [type, names] of Object.entries(byType).sort())
    lines.push(
      `  ${type} ${names.length}: ${names.slice(0, 12).join(", ")}${names.length > 12 ? " ..." : ""}`,
    );
  lines.push(`armatures: ${(extra.armatures ?? []).join(", ") || "(none)"}`);
  lines.push(`actions: ${(extra.actions ?? []).join(", ") || "(none)"}`);
  lines.push(
    `meshes: ${(extra.meshes ?? []).length} collections: ${(extra.collections ?? []).join(", ") || "(none)"}`,
  );
  console.log(lines.join("\n"));
  out({ ok: true, objects: objects.length });
};

const cmdExport = async (gameDir: string, name: string, dest: string): Promise<void> => {
  if (!name || !dest) fail("Usage: blender export <object|collection> <path.glb> [--dir GAME].");
  const absolute = NodePath.resolve(dest);
  await NodeFSP.mkdir(NodePath.dirname(absolute), { recursive: true });
  const { port } = await sessionFor(gameDir);
  let answer = await callAddon(
    port,
    "export_scene",
    { filepath: absolute, format: "glb", object_names: [name] },
    600_000,
  );
  if (answer && typeof answer === "object" && "error" in (answer as Record<string, unknown>)) {
    // Maybe a collection: resolve its member roots, then export those.
    const members = unwrap(
      await callAddon(
        port,
        "execute_code",
        {
          code: `import bpy, json\nc = bpy.data.collections.get(${JSON.stringify(name)})\nprint(json.dumps([o.name for o in c.objects] if c else []))`,
        },
        120_000,
      ),
    ) as { result?: string };
    let names: string[] = [];
    try {
      names = JSON.parse(
        `${members?.result ?? "[]"}`
          .split("\n")
          .filter((l) => l.trim().startsWith("["))
          .join("\n") || "[]",
      ) as string[];
    } catch {
      names = [];
    }
    if (names.length === 0) fail(`Blender: no object or collection named '${name}'.`);
    answer = unwrap(
      await callAddon(
        port,
        "export_scene",
        { filepath: absolute, format: "glb", object_names: names },
        600_000,
      ),
    );
  }
  const done = answer as { path?: string; bytes?: number; exported?: string[] };
  out({ ok: true, path: absolute, bytes: done?.bytes ?? 0, exported: done?.exported ?? [] });
};

const BLENDER_USAGE = `blender: direct Blender control on a private display (no MCP client needed).

  blender start [--dir GAME] [--port N]   Boot UI Blender + addon socket server
  blender stop [--dir GAME]                Kill only the recorded PIDs
  blender status [--dir GAME]              Show the recorded session
  blender exec <file.py> [--dir GAME]      Run a script, print its output/errors
  blender capture <out.png> [--dir GAME]   Real image of the scene (viewport;
                                           render fallback under software GL)
  blender scene [--dir GAME]               Objects, armatures and actions summary
  blender export <name> <path.glb>         GLB incl. rig+animations (object or
  [--dir GAME]                             collection name; children included)

Direct socket calls answer instantly; prefer them over the MCP route.`;

const main = async (): Promise<void> => {
  const { values, positionals } = NodeUtil.parseArgs({
    options: { dir: { type: "string" }, port: { type: "string" } },
    allowPositionals: true,
  });
  const gameDir = NodePath.resolve(values.dir ?? process.cwd());
  const [command, ...rest] = positionals as string[];
  if (command === "start") await start(gameDir, values.port ? Number(values.port) : undefined);
  else if (command === "stop") await stop(gameDir);
  else if (command === "exec") await cmdExec(gameDir, rest[0]!);
  else if (command === "capture") await cmdCapture(gameDir, rest[0]!);
  else if (command === "scene") await cmdScene(gameDir);
  else if (command === "export") await cmdExport(gameDir, rest[0]!, rest[1]!);
  else if (command === "status") {
    const session = await NodeFSP.readFile(sessionPath(gameDir), "utf8")
      .then((t) => JSON.parse(t) as unknown)
      .catch(() => null);
    out({ ok: true, session });
  } else {
    console.log(BLENDER_USAGE);
    process.exit(2);
  }
};

await main().catch((error: unknown) =>
  fail(error instanceof Error ? error.message : String(error)),
);
