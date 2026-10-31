#!/usr/bin/env node
// studio-image: one OpenAI-compatible image call for builders.
// Reads STUDIO_IMAGE_BASE_URL, STUDIO_IMAGE_KEY and STUDIO_IMAGE_MODEL.
// When unset it prints that no generator is configured and exits nonzero.
// NOTE: untested (no key available at build time); see the run report.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const { values, positionals } = NodeUtil.parseArgs({
  options: {
    prompt: { type: "string" },
    out: { type: "string" },
    size: { type: "string", default: "1024x1024" },
  },
  allowPositionals: true,
});
const base = (process.env.STUDIO_IMAGE_BASE_URL ?? "").replace(/\/+$/, "");
const key = process.env.STUDIO_IMAGE_KEY ?? "";
const model = process.env.STUDIO_IMAGE_MODEL ?? "";
if (!base || !key || !model) {
  console.log(
    "studio-image: no image generator configured " +
      "(set STUDIO_IMAGE_BASE_URL, STUDIO_IMAGE_KEY and STUDIO_IMAGE_MODEL).",
  );
  process.exit(3);
}
const prompt = values.prompt ?? positionals.join(" ");
const out = values.out ?? positionals[0];
if (!prompt || !out) {
  console.log("usage: node studio-image.ts --prompt TEXT --out file.png [--size 1024x1024]");
  process.exit(2);
}
const response = await fetch(`${base}/images/generations`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
  body: JSON.stringify({ model, prompt, size: values.size, n: 1 }),
});
if (!response.ok) {
  console.log(
    `studio-image: endpoint ${response.status}: ${(await response.text()).slice(0, 300)}`,
  );
  process.exit(1);
}
const data = (await response.json()) as {
  data?: Array<{ b64_json?: string; url?: string }>;
};
const first = data.data?.[0];
if (!first) {
  console.log("studio-image: empty result.");
  process.exit(1);
}
await NodeFSP.mkdir(NodePath.dirname(NodePath.resolve(out)), { recursive: true });
if (first.b64_json) await NodeFSP.writeFile(out, Buffer.from(first.b64_json, "base64"));
else if (first.url) {
  const image = await fetch(first.url);
  if (!image.ok) {
    console.log(`studio-image: download ${image.status}.`);
    process.exit(1);
  }
  await NodeFSP.writeFile(out, Buffer.from(await image.arrayBuffer()));
} else {
  console.log("studio-image: result has no image.");
  process.exit(1);
}
console.log(`studio-image: ${out}`);
