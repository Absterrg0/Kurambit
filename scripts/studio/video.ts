#!/usr/bin/env node
// studio-video: viewport frames to mp4. Stitches the play session's act
// screenshots (one per act, taken under the private display) into an mp4
// with ffmpeg at about 10 fps. No audio.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const { values } = NodeUtil.parseArgs({
  options: {
    dir: { type: "string" },
    src: { type: "string" },
    out: { type: "string" },
    fps: { type: "string", default: "10" },
    max: { type: "string", default: "1200" },
  },
});
if (!values.out || (!values.dir && !values.src)) {
  console.log(
    "usage: node video.ts --dir <gameDir> [--src <framesDir>] --out <file.mp4> [--fps 10] [--max 1200]",
  );
  process.exit(2);
}
const session = values.src
  ? NodePath.resolve(values.src)
  : NodePath.join(NodePath.resolve(values.dir!), "builds", "logs", "play");
const entries = (await NodeFSP.readdir(session).catch(() => [] as string[]))
  .filter((name) => /^act-\d+\.png$/.test(name))
  .sort()
  .slice(-Math.max(1, Number(values.max)));
if (entries.length < 2) {
  console.log(`studio-video: only ${entries.length} frame(s) in ${session}; need 2+.`);
  process.exit(1);
}
const tmp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.homedir(), ".gs-tmp", "vid-"));
try {
  let index = 0;
  for (const name of entries) {
    index += 1;
    await NodeFSP.copyFile(
      NodePath.join(session, name),
      NodePath.join(tmp, `f-${String(index).padStart(4, "0")}.png`),
    );
  }
  await NodeFSP.mkdir(NodePath.dirname(NodePath.resolve(values.out)), { recursive: true });
  const code = await new Promise<number | null>((resolve) => {
    const child = NodeChildProcess.spawn(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-framerate",
        String(Number(values.fps) || 10),
        "-i",
        NodePath.join(tmp, "f-%04d.png"),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-vf",
        "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        NodePath.resolve(values.out),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let err = "";
    child.stderr?.on("data", (chunk: Buffer) => (err += chunk.toString()));
    child.on("close", (c) => {
      if (c !== 0) console.log(`studio-video: ffmpeg failed: ${err.slice(-400)}`);
      resolve(c);
    });
  });
  if (code !== 0) process.exit(1);
  console.log(`studio-video: ${entries.length} frames -> ${values.out}`);
} finally {
  await NodeFSP.rm(tmp, { recursive: true, force: true });
}
