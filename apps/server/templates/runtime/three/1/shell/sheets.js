// Pictures and flipbooks from texture sheets: cards, tiles, tokens, icons, drawn effects and 2D
// characters. One format for every sheet (`<name>.sheet.json`, written by game_assets op pictures
// and the earlier game_blender op sprites; an older sprites `.sprite.json` reads the same), one player.
//
//   export const ASSETS = { cards: "assets/sheets/cards.sheet.json", fx: "assets/sheets/fx.sheet.json" };
//   const cards = ctx.assets.sheet("cards");
//   cards.names;                                   // every frame's name; cards.clips the animations
//   const card = cards.plane("ace_spades", { width: 0.63, back: "back" }); // a lit card, its back
//     // on the other side; flip it by turning it (card.rotation.y = Math.PI)
//   cards.sprite("coin", { width: 0.5 });          // always faces the camera
//   cards.texture("heart");                        // that frame alone, for a material or a HUD
//   const burst = ctx.assets.sheet("fx").play("burst", { width: 3, blending: "additive", once: true });
//   scene.add(burst);                              // plays on game time; burst.flipbook.done when over
//   burst.flipbook.restart();                      // again, from its first frame
//   play(clip, { sprite: true }) faces the camera; { fps } overrides the sheet's rate.
//
// Sizes are metres: `width` sets it, the height follows the frame's shape. A sheet's pivot (the
// point at the object's origin) is its own: the centre, or a strip's ground line. A sheet made
// under a pixel or voxel lock draws its texels square (filter "nearest").
import * as THREE from "../vendor/three.module.js";

const live = new Set();

const frameRect = (info, frame) => {
  const [w, h] = info.frame;
  const image = info.textures[frame.image].image;
  return {
    u0: frame.x / image.width,
    u1: (frame.x + w) / image.width,
    v0: 1 - (frame.y + h) / image.height,
    v1: 1 - frame.y / image.height,
  };
};

/** A plane `width` metres wide with the frame's pivot at the origin. */
const planeGeometry = (info, frame, width) => {
  const [w, h] = info.frame;
  const height = (width * h) / w;
  const geometry = new THREE.PlaneGeometry(width, height);
  const [px, py] = frame.pivot ?? info.pivot;
  geometry.translate((0.5 - px) * width, (0.5 - py) * height, 0);
  return geometry;
};

const setUv = (geometry, rect) => {
  // PlaneGeometry's corners: top left, top right, bottom left, bottom right.
  geometry.attributes.uv.array.set([
    rect.u0,
    rect.v1,
    rect.u1,
    rect.v1,
    rect.u0,
    rect.v0,
    rect.u1,
    rect.v0,
  ]);
  geometry.attributes.uv.needsUpdate = true;
};

const BLENDING = { normal: THREE.NormalBlending, additive: THREE.AdditiveBlending };

/** Reads a .sheet.json (or an older .sprite.json, its frames laid in one canvas) into a sheet. */
export async function loadSheet(path, loader) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`not found (${response.status})`);
  const info = await response.json();
  const folder = path.slice(0, path.lastIndexOf("/") + 1);
  if (path.endsWith(".sprite.json")) return spriteManifest(info, folder, loader);
  if (info?.version !== 1 || !Array.isArray(info.images) || !Array.isArray(info.frames))
    throw new Error("it is not a version 1 sheet (images, frames)");
  const textures = await Promise.all(info.images.map((file) => loader.loadAsync(folder + file)));
  return makeSheet({ ...info, pivot: info.pivot ?? [0.5, 0.5], textures });
}

/** The earlier game_blender op sprites' manifest before sheets: one PNG per frame, one strip per view. */
async function spriteManifest(manifest, folder, loader) {
  const views = Object.entries(manifest.views ?? {});
  const w = manifest.frameWidth;
  const h = manifest.frameHeight;
  const count = Math.max(1, ...views.map(([, view]) => view.frames.length));
  const canvas = document.createElement("canvas");
  canvas.width = w * count;
  canvas.height = h * views.length;
  const context = canvas.getContext("2d");
  const frames = [];
  const clips = {};
  for (const [row, [name, view]] of views.entries()) {
    clips[name] = { frames: [], fps: manifest.fps || 12, loop: manifest.loop !== false };
    for (const [column, file] of view.frames.entries()) {
      const image = (await loader.loadAsync(folder + file)).image;
      context.drawImage(image, column * w, row * h);
      clips[name].frames.push(frames.length);
      frames.push({ name: file.replace(/\.png$/, ""), image: 0, x: column * w, y: row * h });
    }
  }
  const [, first] = views[0] ?? [null, null];
  const anchor = first?.anchor;
  const pivot = anchor === undefined ? [0.5, 0.5] : [anchor.x / w, 1 - anchor.y / h];
  return makeSheet({
    frame: [w, h],
    pivot,
    filter: "linear",
    frames,
    clips,
    textures: [new THREE.CanvasTexture(canvas)],
  });
}

function makeSheet(info) {
  for (const texture of info.textures) {
    texture.colorSpace = THREE.SRGBColorSpace;
    if (info.filter === "nearest") {
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
    } else texture.anisotropy = 4;
    texture.needsUpdate = true;
  }
  const byName = new Map(info.frames.map((frame, index) => [frame.name, index]));
  const index = (name) => {
    const found = typeof name === "number" ? name : byName.get(name);
    if (found === undefined || info.frames[found] === undefined)
      throw new Error(
        `No frame "${name}" in the sheet: ${[...byName.keys()].slice(0, 12).join(", ")}`,
      );
    return found;
  };
  const lit = new Map();
  const litMaterial = (image) => {
    if (!lit.has(image))
      lit.set(
        image,
        new THREE.MeshStandardMaterial({
          map: info.textures[image],
          alphaTest: 0.5,
          roughness: 0.8,
        }),
      );
    return lit.get(image);
  };
  const frameTexture = (name) => {
    const frame = info.frames[index(name)];
    const rect = frameRect(info, frame);
    const texture = info.textures[frame.image].clone();
    texture.offset.set(rect.u0, rect.v0);
    texture.repeat.set(rect.u1 - rect.u0, rect.v1 - rect.v0);
    texture.needsUpdate = true;
    return texture;
  };
  const face = (name, width) => {
    const frame = info.frames[index(name)];
    const geometry = planeGeometry(info, frame, width);
    setUv(geometry, frameRect(info, frame));
    const mesh = new THREE.Mesh(geometry, litMaterial(frame.image));
    mesh.castShadow = mesh.receiveShadow = true;
    return mesh;
  };
  return {
    names: [...byName.keys()],
    clips: info.clips ?? {},
    frame: info.frame,
    texture: frameTexture,
    plane(name, { width = 1, back } = {}) {
      const front = face(name, width);
      if (back === undefined) {
        front.name = String(name);
        return front;
      }
      const group = new THREE.Group();
      const reverse = face(back, width);
      // The back faces the other way, mirrored so its picture reads the right way round.
      reverse.rotation.y = Math.PI;
      group.add(front, reverse);
      group.name = String(name);
      return group;
    },
    sprite(name, { width = 1 } = {}) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: frameTexture(name), alphaTest: 0.01 }),
      );
      const [w, h] = info.frame;
      sprite.scale.set(width, (width * h) / w, 1);
      sprite.center.set(...(info.frames[index(name)].pivot ?? info.pivot));
      sprite.name = String(name);
      return sprite;
    },
    play(clipName, { width = 1, sprite = false, blending = "normal", once, fps } = {}) {
      const clip = info.clips?.[clipName];
      if (clip === undefined)
        throw new Error(
          `No clip "${clipName}" in the sheet: ${Object.keys(info.clips ?? {}).join(", ")}`,
        );
      const first = info.frames[clip.frames[0]];
      const glow = blending === "additive";
      let object;
      let show;
      if (sprite) {
        // Its own copy of each sheet image, so its frame is its own.
        const maps = info.textures.map((texture) => {
          const copy = texture.clone();
          copy.needsUpdate = true;
          return copy;
        });
        object = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: maps[first.image],
            blending: BLENDING[blending],
            depthWrite: false,
            transparent: true,
          }),
        );
        const [w, h] = info.frame;
        object.scale.set(width, (width * h) / w, 1);
        object.center.set(...(first.pivot ?? info.pivot));
        show = (frame) => {
          const rect = frameRect(info, frame);
          const map = maps[frame.image];
          object.material.map = map;
          map.offset.set(rect.u0, rect.v0);
          map.repeat.set(rect.u1 - rect.u0, rect.v1 - rect.v0);
        };
      } else {
        const geometry = planeGeometry(info, first, width);
        const material = new THREE.MeshBasicMaterial({
          map: info.textures[first.image],
          transparent: true,
          depthWrite: false,
          blending: BLENDING[blending],
          side: THREE.DoubleSide,
        });
        object = new THREE.Mesh(geometry, material);
        show = (frame) => {
          material.map = info.textures[frame.image];
          setUv(geometry, frameRect(info, frame));
        };
      }
      object.name = clipName;
      if (glow) object.renderOrder = 10;
      const rate = fps ?? clip.fps ?? 12;
      const loop = once === undefined ? clip.loop !== false : !once;
      const flipbook = {
        time: 0,
        done: false,
        restart() {
          flipbook.time = 0;
          flipbook.done = false;
          object.visible = true;
          show(info.frames[clip.frames[0]]);
        },
        tick(dt) {
          if (flipbook.done) return;
          flipbook.time += dt;
          let at = Math.floor(flipbook.time * rate);
          if (at >= clip.frames.length) {
            if (loop) at %= clip.frames.length;
            else {
              flipbook.done = true;
              object.visible = false;
              return;
            }
          }
          show(info.frames[clip.frames[at]]);
        },
      };
      object.flipbook = flipbook;
      show(first);
      live.add(object);
      return object;
    },
  };
}

// The shell's side: every flipbook in the scene steps on game time; a new run starts empty.
export const sheetsShell = {
  update(dt) {
    for (const object of live) if (object.parent !== null) object.flipbook.tick(dt);
  },
  reset() {
    live.clear();
  },
};
