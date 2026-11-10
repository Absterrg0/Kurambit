#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off preferSchemaOverJson:off globalDate:off globalTimers:off globalConsole:off -- A maintainer script: crawls each source's own index, downloads and hashes what it pins, and writes the library's index files.
//
// Rebuilds the asset library's generated index files under src/game/library/, one source at a
// time. Each source adapter turns the source's own index into library entries, keeping only
// licences a sold game may ship under (shippableLicence) and pinning every download by what the
// source publishes: a SHA-256 hashed here for archives and loose files we download once, Poly
// Haven's own MD5 and size, ambientCG's size. Review the diff before committing: a changed pin
// or licence is a change to what games ship.
//
//   node apps/server/scripts/library-index.ts polyhaven|ambientcg|packs [--only <id regex>] [--sources kenney,quaternius,quaternius-site,kaykit]
//   node apps/server/scripts/library-index.ts mirror <out dir> [--only <id regex>] [--from <dir>]
//
// TMPDIR holds one pack at a time while it is hashed and indexed.
//
// A pack whose bytes come from a host that throttles every install (awaitsMirror) is offered
// once it is mirrored: `mirror` zips its pinned files, each checked against its pin, as
// <id>.zip; upload those to the MIRROR release (gh release upload, never --clobber); then
// `packs` pins every candidate the release holds as that archive instead of its source's files.
// When Drive throttles every script, a person can still download a pack's folder in a browser:
// `--from <dir>` takes each pinned file from there (any layout, found by its SHA-256) before
// asking Drive, so the pin still guards every byte.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import { CURATED_PACKS, LIBRARY_RIG_JOINTS } from "../src/game/assetLibraryCatalog.ts";
import JSZip from "jszip";
import {
  UNPACK_LIMITS,
  awaitsMirror,
  entryLicenceProblem,
  filesDigest,
  indexPack,
  shippableLicence,
  unpackArchive,
  type LibraryIndex,
  type LibraryPack,
  type LibraryPackFile,
} from "../src/game/assetLibraryFiles.ts";
import { readGltfJson } from "../src/game/gltfJson.ts";
import { hashFile } from "../src/game/sourceSnapshot.ts";

const OUT = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../src/game/library",
);
const AGENT = "Kurambit asset library (https://github.com/Absterrg0/Kurambit)";
const today = new Date().toISOString().slice(0, 10);
/** A regular expression over entry ids: only those are pinned again, the rest of the file is kept. */
const only = process.argv.includes("--only")
  ? new RegExp(process.argv[process.argv.indexOf("--only") + 1] ?? "")
  : undefined;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const get = async (url: string, tries = 4): Promise<Response> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "user-agent": AGENT }, redirect: "follow" });
      if (response.ok) return response;
      if (response.status < 500 && response.status !== 429)
        throw new Error(`${url}: HTTP ${response.status}`);
      if (attempt >= tries) throw new Error(`${url}: HTTP ${response.status}`);
    } catch (error) {
      if (attempt >= tries || String(error).includes("HTTP 4")) throw error;
    }
    await sleep(2000 * attempt);
  }
};
const json = async (url: string) => (await get(url)).json() as Promise<unknown>;
const text = async (url: string) => (await get(url)).text();

/** Runs `work` over `items`, `limit` at a time, in order of the results. */
const pool = async <T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  work: (item: T, index: number) => Promise<R>,
) => {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index]!, index);
      }
    }),
  );
  return results;
};

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 52)
    .replace(/-+$/g, "");

const writeIndex = async (name: string, data: unknown) => {
  await NodeFSP.mkdir(OUT, { recursive: true });
  const file = NodePath.join(OUT, `${name}.json`);
  await NodeFSP.writeFile(file, `${JSON.stringify(data, null, 0).replace(/},{/g, "},\n{")}\n`);
  console.log(`wrote ${file}`);
};

// https://api.polyhaven.com (terms: github.com/Poly-Haven/Public-API/blob/master/ToS.md): free for
// any use, an app-named user agent, and Poly Haven named beside its content. Every asset is CC0.
type PolyHavenFile = { readonly url: string; readonly size: number; readonly md5: string };
const PH_BASE = "https://dl.polyhaven.org/file/ph-assets/";
const polyHaven = async () => {
  const assets = (await json("https://api.polyhaven.com/assets")) as Record<
    string,
    {
      name: string;
      type: 0 | 1 | 2;
      categories: string[];
      tags: string[];
      authors: Record<string, string>;
      polycount?: number;
      dimensions?: number[];
    }
  >;
  const ids = Object.keys(assets).toSorted();
  const rows = await pool(ids, 6, async (id) => {
    const asset = assets[id]!;
    const files = (await json(
      `https://api.polyhaven.com/files/${encodeURIComponent(id)}`,
    )) as Record<string, any>;
    const pick = (path: string, file: PolyHavenFile | undefined) =>
      file === undefined || !file.url.startsWith(PH_BASE)
        ? undefined
        : ([path, file.url.slice(PH_BASE.length), file.size, file.md5] as const);
    let type: string;
    let list: Array<ReturnType<typeof pick>> = [];
    if (asset.type === 0) {
      type = "hdri";
      const hdr: PolyHavenFile | undefined = files.hdri?.["1k"]?.hdr;
      list = [pick(`${id}_1k.hdr`, hdr)];
    } else if (asset.type === 1) {
      type = "texture";
      const map = (key: string) => files[key]?.["1k"]?.jpg as PolyHavenFile | undefined;
      const name = (key: string, file: PolyHavenFile | undefined) =>
        file === undefined ? "" : decodeURIComponent(file.url.slice(file.url.lastIndexOf("/") + 1));
      list = ["Diffuse", "nor_gl", "arm", "Displacement"].map((key) =>
        pick(name(key, map(key)), map(key)),
      );
      if (map("arm") === undefined)
        list.push(...["Rough", "AO"].map((key) => pick(name(key, map(key)), map(key))));
    } else {
      type = "model";
      const gltf = files.gltf?.["1k"]?.gltf as
        | (PolyHavenFile & { include?: Record<string, PolyHavenFile> })
        | undefined;
      if (gltf !== undefined) {
        const main = decodeURIComponent(gltf.url.slice(gltf.url.lastIndexOf("/") + 1));
        list = [
          pick(main, gltf),
          ...Object.entries(gltf.include ?? {}).map(([path, file]) => pick(path, file)),
        ];
      }
    }
    const kept = list.filter((file) => file !== undefined);
    // A material needs at least its colour; a model or sky its main file.
    if (kept.length === 0 || (type === "texture" && list[0] === undefined)) {
      console.warn(`polyhaven ${id}: no usable files`);
      return null;
    }
    return {
      id,
      name: asset.name,
      type,
      authors: Object.keys(asset.authors).join(", "),
      tags: [...new Set([...asset.categories, ...asset.tags].map((tag) => tag.toLowerCase()))].join(
        " ",
      ),
      ...(asset.polycount === undefined ? {} : { tris: asset.polycount }),
      ...(asset.dimensions === undefined
        ? {}
        : { size: asset.dimensions.map((mm) => Math.round(mm) / 1000) }),
      files: kept,
    };
  });
  const kept = rows.filter((row) => row !== null);
  await writeIndex("polyhaven", {
    source: "polyhaven",
    fetched: today,
    base: PH_BASE,
    assets: kept,
  });
  console.log(`polyhaven: ${kept.length} of ${ids.length}`);
};

// https://docs.ambientcg.com/api/v3/assets/ : every asset is CC0 (docs.ambientcg.com/license).
// The API is one person's; one crawl per index refresh, never per install. No hash is published,
// so each download is pinned by its size.
const AMBIENT_TYPES = { material: "1K-JPG", decal: "1K-JPG", atlas: "1K-JPG", hdri: "1K" } as const;
const ambientCg = async () => {
  const assets: Array<Record<string, unknown>> = [];
  for (const [type, attribute] of Object.entries(AMBIENT_TYPES)) {
    for (let offset = 0; ; offset += 500) {
      const page = (await json(
        `https://ambientcg.com/api/v3/assets?type=${type}&include=downloads,tags,title&sort=alphabet&limit=500&offset=${offset}`,
      )) as {
        assets: Array<{
          id: string;
          title: string;
          tags: string[];
          downloads: Array<{ attributes: string; extension: string; url: string; size: number }>;
        }>;
      };
      for (const asset of page.assets) {
        const download = asset.downloads.find(
          (d) => d.attributes === attribute && d.extension === "zip",
        );
        if (download === undefined) continue;
        const file = download.url.replace("https://ambientcg.com/get?file=", "");
        assets.push({
          id: asset.id,
          name: asset.title,
          type,
          tags: asset.tags
            .filter((tag) => !/^\d+$/.test(tag) && tag !== asset.id.toLowerCase())
            .join(" "),
          bytes: download.size,
          file,
        });
      }
      if (page.assets.length < 500) break;
      await sleep(1000);
    }
  }
  await writeIndex("ambientcg", { source: "ambientcg", fetched: today, assets });
  console.log(`ambientcg: ${assets.length}`);
};

interface Candidate {
  readonly id: string;
  readonly title: string;
  readonly author: string;
  readonly source: string;
  readonly licenceText: string;
  readonly licenceEvidence: string;
  readonly family: string;
  readonly style: string;
  readonly tags: string;
  readonly archive?: { readonly url: string; readonly bytes?: number };
  readonly files?: ReadonlyArray<{ readonly path: string; readonly url: string }>;
}

const OGA = "https://opengameart.org";
/** Every 3D art node a creator uploaded to OpenGameArt under exactly CC0, with its first zip. */
const openGameArt = async (
  user: string,
): Promise<Array<Omit<Candidate, "id" | "family" | "style">>> => {
  const names: string[] = [];
  for (let page = 0; ; page += 1) {
    const html = await text(`${OGA}/users/${user}?page=${page}`);
    const found = [
      ...html.matchAll(/<div class="field-item even"><a href="\/content\/([^"]+)">/g),
    ].map((m) => m[1]!);
    const fresh = [...new Set(found)].filter((name) => !names.includes(name));
    if (fresh.length === 0) break;
    names.push(...fresh);
    await sleep(1000);
  }
  const out: Array<Omit<Candidate, "id" | "family" | "style">> = [];
  for (const name of names) {
    const html = await text(`${OGA}/content/${name}`);
    await sleep(1000);
    const type = /field-name-field-art-type.*?<a [^>]*>([^<]+)<\/a>/s.exec(html)?.[1];
    const licences = [...html.matchAll(/class='license-name'>([^<]+)</g)].map((m) => m[1]!);
    const submitter = /field-name-author-submitter.*?<a href="\/users\/([^"]+)"/s.exec(html)?.[1];
    const zip =
      /<a href="(https:\/\/opengameart\.org\/sites\/default\/files\/[^"]+)" type="[^";]*; length=(\d+)"/.exec(
        html,
      );
    if (type !== "3D Art" || licences.length !== 1 || submitter !== user || zip === null) continue;
    if (!/\.zip$/i.test(zip[1]!) && !/zip/i.test(html.slice(zip.index, zip.index + 300))) continue;
    const title = (/<title>(.*?) \| OpenGameArt\.org<\/title>/.exec(html)?.[1] ?? name)
      .replace(/&amp;/g, "&")
      .replace(/&#039;/g, "'");
    const tags = [...html.matchAll(/field_art_tags_tid=[^"]*"[^>]*>([^<]+)<\/a>/g)].map((m) =>
      m[1]!.toLowerCase(),
    );
    out.push({
      title,
      author: user === "kenney" ? "Kenney" : "Quaternius",
      source: `${OGA}/content/${name}`,
      licenceText: licences[0]!,
      licenceEvidence: `${OGA}/content/${name}`,
      tags: tags.join(" "),
      archive: { url: zip[1]!, bytes: Number(zip[2]) },
    });
  }
  return out;
};

const DRIVE_FILE = (id: string) =>
  `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
const driveFolder = async (id: string) => {
  const html = await text(`https://drive.google.com/embeddedfolderview?id=${id}`);
  return [
    ...html.matchAll(
      /href="(https:\/\/drive\.google\.com\/[^"]+)"[^>]*>.*?flip-entry-title">([^<]+)</gs,
    ),
  ].map((m) => {
    const href = m[1]!.replace(/&amp;/g, "&");
    const folder = /\/folders\/([A-Za-z0-9_-]+)/.exec(href)?.[1];
    const file = /\/file\/d\/([A-Za-z0-9_-]+)/.exec(href)?.[1];
    return { name: m[2]!.replace(/&amp;/g, "&").trim(), folder, file };
  });
};
/** Every file under a Drive folder, with paths relative to it, a few folders deep. */
const driveTree = async (
  id: string,
  prefix = "",
  depth = 0,
): Promise<Array<{ path: string; url: string }>> => {
  const out: Array<{ path: string; url: string }> = [];
  for (const entry of await driveFolder(id)) {
    if (entry.file !== undefined)
      out.push({ path: `${prefix}${entry.name}`, url: DRIVE_FILE(entry.file) });
    else if (entry.folder !== undefined && depth < 3) {
      await sleep(300);
      out.push(...(await driveTree(entry.folder, `${prefix}${entry.name}/`, depth + 1)));
    }
  }
  return out;
};

/** Quaternius' own site: each pack page links one public Drive folder; the site is CC0 throughout. */
const QUATERNIUS_CURATED: Record<string, string> = {
  knightcharacter: "quaternius-knight",
  animatedmonster: "quaternius-monsters",
  ultimatedanimatedcharacter: "quaternius-ultimate-characters",
  universalanimationlibrary: "quaternius-universal-animation-library",
  universalanimationlibrary2: "quaternius-universal-animation-library-2",
  universalbasecharacters: "quaternius-universal-base-characters",
  medievalvillagemegakit: "quaternius-medieval-village",
  stylizednaturemegakit: "quaternius-stylized-nature",
};
const quaterniusSite = async (): Promise<Candidate[]> => {
  const index = await text("https://quaternius.com/index.html");
  const pages = [...new Set([...index.matchAll(/packs\/([a-z0-9_-]+)\.html/g)].map((m) => m[1]!))];
  const out: Candidate[] = [];
  for (const page of pages) {
    if (QUATERNIUS_CURATED[page] !== undefined) continue;
    const url = `https://quaternius.com/packs/${page}.html`;
    const html = await text(url);
    await sleep(500);
    const folder = /drive\.google\.com\/drive\/folders\/([A-Za-z0-9_-]+)/.exec(html)?.[1];
    const cc0 = html.includes("creativecommons.org/publicdomain/zero/1.0/");
    const title = (/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? page)
      .replace(/\s*[-|·•]\s*Quaternius.*$/i, "")
      .replace(/^\s*Quaternius\s*[-|·•:]?\s*/i, "")
      .trim();
    if (folder === undefined || !cc0) {
      console.warn(
        `quaternius ${page}: ${folder === undefined ? "no Drive folder (itch only)" : "no CC0 mark"}`,
      );
      continue;
    }
    const top = await driveFolder(folder);
    // One format per pack, the one the engines load best; the pack's licence and picture beside it.
    const formats = ["gltf", "glb", "fbx", "obj"];
    const pickFolder = formats
      .map((format) =>
        top.find((entry) => entry.folder !== undefined && entry.name.toLowerCase() === format),
      )
      .find((entry) => entry !== undefined);
    const files: Array<{ path: string; url: string }> = [];
    if (pickFolder?.folder !== undefined)
      files.push(...(await driveTree(pickFolder.folder, `${pickFolder.name}/`)));
    else files.push(...(await driveTree(folder)).filter((file) => !/\.blend1?$/i.test(file.path)));
    for (const entry of top)
      if (
        entry.file !== undefined &&
        /^(licen[cs]e.*\.txt|preview\.(png|jpe?g))$/i.test(entry.name) &&
        !files.some((file) => file.path === entry.name)
      )
        files.push({ path: entry.name, url: DRIVE_FILE(entry.file) });
    if (!files.some((file) => /\.(gltf|glb|fbx|obj)$/i.test(file.path))) {
      console.warn(`quaternius ${page}: no models in its Drive folder`);
      continue;
    }
    out.push({
      id: `quaternius-${slug(title.replace(/^ultimate\s+/i, ""))}`,
      title,
      author: "Quaternius",
      source: url,
      licenceText: "CC0",
      licenceEvidence: url,
      family: "quaternius-lowpoly",
      style: "low-poly, flat colours",
      tags: "",
      files,
    });
  }
  return out;
};

const download = async (url: string, destination: string, cap: number) => {
  const response = await get(url);
  if (!response.body) throw new Error(`${url}: no body`);
  let received = 0;
  await NodeStreamPromises.pipeline(
    NodeStream.Readable.fromWeb(response.body as never),
    new NodeStream.Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.byteLength;
        callback(received > cap ? new Error(`${url}: larger than ${cap} bytes`) : null, chunk);
      },
    }),
    NodeFS.createWriteStream(destination, { flags: "wx" }),
  );
};

/** The rig its characters share, or none when each model is on a skeleton of its own. */
const rigOf = async (directory: string, index: LibraryIndex, id: string) => {
  const signatures = new Map<string, string[]>();
  let animated = 0;
  let skinned = 0;
  for (const file of index.files) {
    if (file.format !== "glb" && file.format !== "gltf") continue;
    const read = await readGltfJson(NodePath.join(directory, file.path), 64 * 1024 * 1024);
    if (read.kind !== "json") continue;
    const doc = read.json as {
      skins?: Array<{ joints: number[] }>;
      nodes?: Array<{ name?: string }>;
      animations?: unknown[];
    };
    if ((doc.animations?.length ?? 0) > 0) animated += 1;
    const skin = doc.skins?.[0];
    if (skin === undefined) continue;
    skinned += 1;
    const joints = skin.joints
      .map((joint) => doc.nodes?.[joint]?.name ?? "")
      .toSorted()
      .join(",");
    signatures.set(joints, [...(signatures.get(joints) ?? []), file.path]);
  }
  if (signatures.size !== 1) return { rig: undefined, animated, skinned };
  const joints = [...signatures.keys()][0]!.split(",");
  const known = Object.entries(LIBRARY_RIG_JOINTS).find(
    ([, names]) => names.length === joints.length && names.every((name) => joints.includes(name)),
  );
  // One skeleton across several characters is a rig their clips share; one model alone is not.
  const count = [...signatures.values()][0]!.length;
  return { rig: known?.[0] ?? (count > 1 ? id : undefined), animated, skinned };
};

const pinPack = async (candidate: Candidate, scratch: string): Promise<LibraryPack | null> => {
  const licence = shippableLicence(candidate.licenceText);
  if (licence === null) {
    console.warn(`${candidate.id}: licence "${candidate.licenceText}" is not shippable; skipped`);
    return null;
  }
  const work = await NodeFSP.mkdtemp(NodePath.join(scratch, `${candidate.id}-`));
  try {
    const files = NodePath.join(work, "files");
    await NodeFSP.mkdir(files);
    let sha256: string;
    let bytes: number;
    let pinned: LibraryPackFile[] | undefined;
    let root: string | undefined;
    if (candidate.archive !== undefined) {
      const archive = NodePath.join(work, "archive.zip");
      await download(candidate.archive.url, archive, 600 * 1024 * 1024);
      ({ sha256, bytes } = await hashFile(archive));
      if (candidate.archive.bytes !== undefined && candidate.archive.bytes !== bytes)
        console.warn(
          `${candidate.id}: the page said ${candidate.archive.bytes} bytes; got ${bytes}`,
        );
      const unpacked = NodePath.join(work, "unpacked");
      await NodeFSP.mkdir(unpacked);
      await Effect.runPromise(unpackArchive(archive, unpacked, UNPACK_LIMITS));
      // A GitHub commit archive holds the pack one folder down, in addons/<pack> when there is one.
      const top = await NodeFSP.readdir(unpacked);
      if (
        /^https:\/\/github\.com\/[^/]+\/[^/]+\/archive\//.test(candidate.archive.url) &&
        top.length === 1
      ) {
        root = top[0]!;
        const addons = await NodeFSP.readdir(NodePath.join(unpacked, root, "addons")).catch(
          () => [],
        );
        if (addons.length === 1) root = `${root}/addons/${addons[0]}`;
      }
      await NodeFSP.rm(files, { recursive: true });
      await NodeFSP.rename(
        root === undefined ? unpacked : NodePath.join(unpacked, ...root.split("/")),
        files,
      );
      await NodeFSP.rm(archive);
    } else {
      pinned = await pool(candidate.files ?? [], 4, async (file) => {
        const destination = NodePath.join(files, ...file.path.split("/"));
        await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
        await download(file.url, destination, 256 * 1024 * 1024);
        const head = (await NodeFSP.readFile(destination)).subarray(0, 64).toString("latin1");
        if (/<!doctype html|<html/i.test(head))
          throw new Error(`${file.path}: the source served a web page`);
        const hashed = await hashFile(destination);
        return { path: file.path, url: file.url, bytes: hashed.bytes, sha256: hashed.sha256 };
      });
      sha256 = filesDigest(pinned);
      bytes = pinned.reduce((sum, file) => sum + file.bytes, 0);
    }
    const index = await indexPack({ id: candidate.id, sha256, bytes }, files);
    const { rig, animated, skinned } = await rigOf(files, index, candidate.id);
    const models = index.files.filter((file) => file.media === "model");
    const formats = [...new Set(index.files.map((file) => file.format))].toSorted();
    if (models.length === 0) {
      console.warn(`${candidate.id}: no models; skipped`);
      return null;
    }
    const stems = [
      ...new Set(
        models.map((file) =>
          file.path.slice(file.path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, ""),
        ),
      ),
    ];
    const words = [
      ...new Set(
        stems
          .flatMap((stem) => stem.toLowerCase().split(/[^a-z]+/))
          .filter((word) => word.length > 2),
      ),
    ];
    const kinds = [
      "model",
      // A skinned model is a character or creature; clips alone also move doors and belts.
      ...(skinned > 0 || /animated|character/i.test(candidate.title) ? ["character"] : []),
      ...(index.files.some((file) => file.media === "audio") ? ["sfx"] : []),
    ] as LibraryPack["kinds"];
    const uniqueModels = stems.length;
    const pack: LibraryPack = {
      id: candidate.id,
      title: candidate.title,
      author: candidate.author,
      source: candidate.source,
      download: candidate.archive?.url ?? pinned![0]!.url,
      sha256,
      bytes,
      licence,
      licenceEvidence: candidate.licenceEvidence,
      ...(pinned === undefined ? {} : { files: pinned }),
      kinds,
      formats,
      style: candidate.style,
      tags: [
        ...new Set(
          `${candidate.tags} ${words.slice(0, 80).join(" ")}`.split(/\s+/).filter(Boolean),
        ),
      ].join(" "),
      description: `${candidate.title}: ${uniqueModels} model${uniqueModels === 1 ? "" : "s"}${animated > 0 ? `, ${animated} with clips of their own` : ""}${skinned > 0 ? `; ${skinned} rigged${rig === undefined ? (skinned > 1 ? ", each on a skeleton of its own" : "") : `, sharing one skeleton`}` : ""}.`,
      family: candidate.family,
      ...(rig === undefined ? {} : { rig }),
      ...(animated > 0 ? { animated } : {}),
      ...(root === undefined ? {} : { root }),
    };
    const problem = entryLicenceProblem(pack);
    if (problem !== null) {
      console.warn(problem);
      return null;
    }
    return pack;
  } finally {
    await NodeFSP.rm(work, { recursive: true, force: true });
  }
};

/**
 * The release of this repository that re-hosts CC0 packs whose own host throttles (Google Drive)
 * or hands out expiring links (itch). The mirror is only a byte host: `source` and
 * `licenceEvidence` stay the author's pages, and the SHA-256 pin still guards every byte.
 */
const MIRROR_RELEASE = "Absterrg0/Kurambit/releases/tags/library-mirror-2026-11";
const MIRROR = "https://github.com/Absterrg0/Kurambit/releases/download/library-mirror-2026-11/";
const mirroredZips = async () => {
  const release = (await json(`https://api.github.com/repos/${MIRROR_RELEASE}`)) as {
    assets: Array<{ name: string }>;
  };
  return new Set(release.assets.map((asset) => asset.name));
};

const MODEL_FORMATS = new Set(["gltf", "glb", "fbx", "obj"]);
/**
 * The files of a held-back pack worth mirroring: the library loads glTF first, so an FBX or OBJ
 * (and its .mtl) goes when the same model ships as glTF, matched by name with the format
 * folders (FBX/, glTF/, OBJ/) left out. Textures, licences and previews stay. Pure.
 */
const mirrorFiles = (files: ReadonlyArray<LibraryPackFile>) => {
  const model = (path: string) => {
    const parts = path.toLowerCase().split("/");
    const name = parts.pop()!;
    const dot = name.lastIndexOf(".");
    return [...parts.filter((part) => !MODEL_FORMATS.has(part)), name.slice(0, dot)].join("/");
  };
  const asGltf = new Set(
    files.filter((file) => /\.(gltf|glb)$/i.test(file.path)).map((file) => model(file.path)),
  );
  return files.filter(
    (file) => !(/\.(fbx|obj|mtl)$/i.test(file.path) && asGltf.has(model(file.path))),
  );
};

/** Drive's throttle answers with this page (status 200), for every file once it starts. */
const DRIVE_QUOTA = "Google Drive - Quota exceeded";
class DriveRefused extends Error {}
// A fixed date keeps a pack's zip, and so its pin, the same whenever it is rebuilt.
const MIRROR_ZIP_DATE = new Date("2026-01-01T00:00:00Z");
const mirror = async () => {
  const out = process.argv[3];
  if (out === undefined || out.startsWith("--")) {
    console.error("usage: library-index.ts mirror <out dir> [--only <id regex>] [--from <dir>]");
    process.exit(2);
  }
  await NodeFSP.mkdir(out, { recursive: true });
  const { packs: indexed } = JSON.parse(
    await NodeFSP.readFile(NodePath.join(OUT, "packs.json"), "utf8"),
  ) as { packs: LibraryPack[] };
  const held = indexed.filter(
    (pack) => awaitsMirror(pack) && pack.files !== undefined && (only?.test(pack.id) ?? true),
  );
  console.log(`mirror: ${held.length} packs wait for the mirror`);
  const local = new Map<string, string>();
  const from = process.argv.includes("--from")
    ? process.argv[process.argv.indexOf("--from") + 1]
    : undefined;
  if (from !== undefined)
    for (const entry of await NodeFSP.readdir(from, { recursive: true, withFileTypes: true }))
      if (entry.isFile()) {
        const path = NodePath.join(entry.parentPath, entry.name);
        local.set((await hashFile(path)).sha256, path);
      }
  for (const pack of held) {
    const zipPath = NodePath.join(out, `${pack.id}.zip`);
    // A stopped run is picked up again: what is already zipped stays.
    if (NodeFS.existsSync(zipPath)) continue;
    const files = mirrorFiles(pack.files!).toSorted((a, b) => a.path.localeCompare(b.path));
    const work = await NodeFSP.mkdtemp(
      NodePath.join(process.env.TMPDIR ?? NodeOS.tmpdir(), "mirror-"),
    );
    try {
      const zip = new JSZip();
      for (const file of files) {
        const destination = NodePath.join(work, ...file.path.split("/"));
        await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
        const copy = file.sha256 === undefined ? undefined : local.get(file.sha256);
        if (copy !== undefined) await NodeFSP.copyFile(copy, destination);
        // The quota page is 2 KB, so a smaller pin must not refuse it before it is recognised.
        else await download(file.url, destination, Math.max(file.bytes, 64 * 1024));
        const head = (await NodeFSP.readFile(destination)).subarray(0, 512).toString("latin1");
        if (head.includes(DRIVE_QUOTA))
          throw new DriveRefused(
            `${pack.id}: Drive is refusing downloads (quota); run again later`,
          );
        const hashed = await hashFile(destination);
        if (hashed.sha256 !== file.sha256 || hashed.bytes !== file.bytes)
          throw new Error(`${file.path}: not the pinned bytes; re-pin the pack from its source`);
        zip.file(file.path, NodeFS.createReadStream(destination), {
          date: MIRROR_ZIP_DATE,
          createFolders: false,
        });
        if (copy === undefined) await sleep(1000);
      }
      await NodeStreamPromises.pipeline(
        zip.generateNodeStream({ type: "nodebuffer", streamFiles: true, compression: "DEFLATE" }),
        NodeFS.createWriteStream(`${zipPath}.part`),
      );
      await NodeFSP.rename(`${zipPath}.part`, zipPath);
      const dropped = pack.files!.length - files.length;
      console.log(
        `${pack.id}: ${(await NodeFSP.stat(zipPath)).size} bytes, ${files.length} files${dropped > 0 ? ` (${dropped} FBX/OBJ beside glTF left out)` : ""}`,
      );
    } catch (error) {
      await NodeFSP.rm(`${zipPath}.part`, { force: true });
      if (error instanceof DriveRefused) throw error;
      console.warn(`${pack.id}: ${String(error)}`);
    } finally {
      await NodeFSP.rm(work, { recursive: true, force: true });
    }
  }
};

const KAYKIT_REPOS = ["KayKit-Prototype-Bits-1.0"];
/** Quaternius OGA uploads whose models no site Drive folder holds (Wolf, Eagle, Piranha…). */
const QUATERNIUS_OGA_ONLY = new Set(["Animated Animales Low Poly"]);
/** Which crawls run (--sources a,b): a re-pin of one source need not crawl the others. */
const sources = process.argv.includes("--sources")
  ? (process.argv[process.argv.indexOf("--sources") + 1] ?? "").split(",")
  : ["kenney", "quaternius", "quaternius-site", "kaykit"];
const packs = async () => {
  // Only the curated packs: the generated file is what this run rewrites.
  const pinnedUrls = new Set(CURATED_PACKS.map((pack) => pack.download));
  const known = new Set(CURATED_PACKS.map((pack) => pack.id));
  const candidates: Candidate[] = [];
  const named = (id: string) => {
    let unique = id;
    for (let n = 2; known.has(unique); n += 1) unique = `${id}-${n}`;
    known.add(unique);
    return unique;
  };
  for (const user of ["kenney", "quaternius"].filter((name) => sources.includes(name)))
    for (const found of await openGameArt(user)) {
      if (pinnedUrls.has(found.archive!.url)) continue;
      // Quaternius' Drive folders carry the same packs per model; from here come only the
      // itch-only megakits and the packs no Drive folder holds (checked by their model files).
      if (
        user === "quaternius" &&
        !/megakit/i.test(found.title) &&
        !QUATERNIUS_OGA_ONLY.has(found.title)
      )
        continue;
      candidates.push({
        ...found,
        id: named(`${user}-${slug(found.title)}`),
        family: user === "kenney" ? "kenney-lowpoly" : "quaternius-lowpoly",
        style:
          user === "kenney"
            ? "low-poly, flat colours or a colormap"
            : "stylised low-poly, textured",
      });
    }
  for (const candidate of sources.includes("quaternius-site") ? await quaterniusSite() : [])
    candidates.push({ ...candidate, id: named(candidate.id) });
  for (const repo of sources.includes("kaykit") ? KAYKIT_REPOS : []) {
    const commit = (
      (await json(`https://api.github.com/repos/KayKit-Game-Assets/${repo}/commits/main`)) as {
        sha: string;
      }
    ).sha;
    candidates.push({
      id: named(`kaykit-${slug(repo.replace(/^KayKit-|-1\.0$/g, ""))}`),
      title: repo.replace(/^KayKit-|-1\.0$/g, "").replace(/-/g, " "),
      author: "Kay Lousberg (KayKit)",
      source: `https://github.com/KayKit-Game-Assets/${repo}`,
      licenceText: "CC0",
      licenceEvidence: `https://github.com/KayKit-Game-Assets/${repo}/blob/${commit}/LICENSE.txt`,
      family: "kaykit",
      style: "low-poly, gradient texture, chunky",
      tags: "3d",
      archive: { url: `https://github.com/KayKit-Game-Assets/${repo}/archive/${commit}.zip` },
    });
  }
  const mirrored = await mirroredZips();
  const chosen = candidates
    .filter((candidate) => only === undefined || only.test(candidate.id))
    .map(({ files, ...candidate }): Candidate =>
      mirrored.has(`${candidate.id}.zip`)
        ? { ...candidate, archive: { url: `${MIRROR}${candidate.id}.zip` } }
        : { ...candidate, ...(files === undefined ? {} : { files }) },
    );
  console.log(`packs: ${chosen.length} candidates`);
  const scratch = await NodeFSP.mkdtemp(
    NodePath.join(process.env.TMPDIR ?? NodeOS.tmpdir(), "library-index-"),
  );
  const previous =
    only === undefined
      ? []
      : (
          JSON.parse(
            await NodeFSP.readFile(NodePath.join(OUT, "packs.json"), "utf8").catch(
              () => '{"packs":[]}',
            ),
          ) as { packs: LibraryPack[] }
        ).packs;
  try {
    const pinned = await pool(chosen, 4, async (candidate) => {
      try {
        const pack = await pinPack(candidate, scratch);
        console.log(
          `${candidate.id}: ${pack === null ? "skipped" : `${pack.bytes} bytes, ${pack.formats.join(" ")}${pack.rig ? `, rig ${pack.rig}` : ""}${pack.animated ? `, ${pack.animated} animated` : ""}`}`,
        );
        return pack;
      } catch (error) {
        console.warn(`${candidate.id}: ${String(error)}`);
        return null;
      }
    });
    const kept = [
      ...previous.filter((pack) => !only!.test(pack.id)),
      ...pinned.filter((pack) => pack !== null),
    ].toSorted((a, b) => a.id.localeCompare(b.id));
    await writeIndex("packs", { fetched: today, packs: kept });
  } finally {
    await NodeFSP.rm(scratch, { recursive: true, force: true });
  }
};

const command = process.argv[2];
const run = { polyhaven: polyHaven, ambientcg: ambientCg, packs, mirror }[command ?? ""];
if (run === undefined) {
  console.error("usage: library-index.ts polyhaven|ambientcg|packs|mirror [--only <id regex>]");
  process.exit(2);
}
await run();
