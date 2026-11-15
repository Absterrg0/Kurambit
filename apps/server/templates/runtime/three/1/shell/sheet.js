// The model sheet the harness asks for (game_model_sheet): one thing the game named, drawn alone
// from the front, the side, the back and above at three quarters, beside a 1.8 m figure on a
// one-metre grid, with what it costs to draw. It is a picture laid over the page; the run under
// it is held, never changed: the thing goes back where it was, as it was, before this returns.
import * as THREE from "../vendor/three.module.js";
import { drawnBox, stats } from "./model.js";

const PERSON_M = 1.8;
const BACKDROP = 0x8c929a;
const VIEWS = [
  { label: "front", dir: [0, 0.12, 1] },
  { label: "right side", dir: [1, 0.12, 0] },
  { label: "back", dir: [0, 0.12, -1] },
  { label: "three quarters, above", dir: [1, 0.8, 1] },
];

const person = () => {
  const grey = new THREE.MeshStandardMaterial({ color: 0x5b6068, roughness: 1 });
  const figure = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.75, 4, 12), grey);
  trunk.position.y = 0.95;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 10), grey);
  head.position.y = PERSON_M - 0.13;
  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.6, 0.18), grey);
  legs.position.y = 0.3;
  figure.add(trunk, head, legs);
  return figure;
};

/**
 * `find(name)` is the named thing's record ({ id, name, kind, object }) or null; `names()` lists
 * the things there are. `hold(on)` freezes the run under the sheet.
 */
export function createSheet({ renderer, find, names, hold }) {
  let overlay = null;
  const close = () => {
    overlay?.remove();
    overlay = null;
    hold(false);
  };

  const draw = (name) => {
    close();
    const record = name == null ? null : find(String(name));
    if (record?.object?.isObject3D !== true)
      return {
        error: name == null ? "name a thing" : `no thing named "${name}" with a body`,
        things: names(),
      };
    hold(true);
    const object = record.object;
    const parent = object.parent;
    const index = parent === null ? -1 : parent.children.indexOf(object);
    const saved = {
      position: object.position.clone(),
      quaternion: object.quaternion.clone(),
      visible: object.visible,
    };
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BACKDROP);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x50555c, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(3, 6, 4);
    scene.add(sun);
    const width = renderer.domElement.width;
    const height = renderer.domElement.height;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    let measured;
    const culled = [];
    try {
      // Alone and upright at the origin, as built: its own scale stays.
      object.position.set(0, 0, 0);
      object.quaternion.identity();
      object.visible = true;
      scene.add(object);
      // A skinned mesh keeps the box of its first pose; measure the pose it holds now. Its
      // sphere is as stale, so nothing is culled by it while the sheet draws.
      // updateMatrixWorld, not updateWorldMatrix: only it refreshes a skinned mesh's bind inverse.
      object.updateMatrixWorld(true);
      object.traverse((node) => {
        if (node.isSkinnedMesh) {
          node.skeleton.update();
          node.computeBoundingBox();
          node.computeBoundingSphere();
        }
        if (node.frustumCulled) {
          culled.push(node);
          node.frustumCulled = false;
        }
      });
      measured = stats(object);
      const box = drawnBox(object);
      object.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
      box.copy(drawnBox(object));
      const size = box.getSize(new THREE.Vector3());
      const figure = person();
      // Beside it, toward the front: never behind it from one side or in front of it from another.
      figure.position.set(box.min.x - 0.7, 0, box.max.z + 0.5);
      scene.add(figure);
      const span = Math.max(size.x, size.z, 1) + 2.5;
      const grid = new THREE.GridHelper(
        Math.ceil(span) * 2,
        Math.ceil(span) * 2,
        0x3a3f46,
        0x737981,
      );
      grid.position.y = 0.002;
      scene.add(grid);
      const all = drawnBox(object).union(new THREE.Box3().setFromObject(figure));
      const centre = all.getCenter(new THREE.Vector3());
      const radius = all.getSize(new THREE.Vector3()).length() / 2;
      const w = Math.floor(width / 2);
      const h = Math.floor(height / 2);
      const aspect = w / h;
      const camera = new THREE.OrthographicCamera();
      const context = canvas.getContext("2d");
      const autoClear = renderer.autoClear;
      const viewport = renderer.getViewport(new THREE.Vector4());
      const css = renderer.getSize(new THREE.Vector2());
      renderer.autoClear = true;
      VIEWS.forEach(({ dir }, i) => {
        const extent = radius * 1.08;
        camera.left = -extent * aspect;
        camera.right = extent * aspect;
        camera.top = extent;
        camera.bottom = -extent;
        camera.near = 0.01;
        camera.far = radius * 8 + 10;
        camera.position
          .copy(centre)
          .addScaledVector(new THREE.Vector3(...dir).normalize(), radius * 3 + 2);
        camera.lookAt(centre);
        camera.updateProjectionMatrix();
        renderer.setViewport(0, 0, css.x, css.y);
        renderer.setScissorTest(false);
        renderer.render(scene, camera);
        // Copied in the same task as the draw, so the drawing buffer still holds it.
        context.drawImage(
          renderer.domElement,
          0,
          0,
          width,
          height,
          (i % 2) * w,
          Math.floor(i / 2) * h,
          w,
          h,
        );
      });
      renderer.autoClear = autoClear;
      renderer.setViewport(viewport);
      measured.size = [size.x, size.y, size.z].map((n) => Math.round(n * 100) / 100);
    } finally {
      for (const node of culled) node.frustumCulled = true;
      scene.remove(object);
      object.position.copy(saved.position);
      object.quaternion.copy(saved.quaternion);
      object.visible = saved.visible;
      if (parent !== null) {
        parent.add(object);
        // Back in its place among its siblings: order can matter to the game.
        parent.children.splice(parent.children.indexOf(object), 1);
        parent.children.splice(index, 0, object);
      }
    }
    overlay = document.createElement("div");
    overlay.id = "kurambit-sheet";
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:#8c929a;font:600 15px system-ui,sans-serif;color:#111";
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%";
    overlay.append(canvas);
    const label = (text, css) => {
      const tag = document.createElement("div");
      tag.textContent = text;
      tag.style.cssText = `position:absolute;padding:3px 7px;background:rgb(255 255 255 / 0.85);border-radius:4px;${css}`;
      overlay.append(tag);
    };
    VIEWS.forEach(({ label: text }, i) =>
      label(text, `left:${(i % 2) * 50 + 0.8}%;top:${Math.floor(i / 2) * 50 + 1.2}%`),
    );
    const [x, y, z] = measured.size;
    label(
      `${record.name}: ${x} × ${y} × ${z} m (wide × tall × long) · ${measured.triangles.toLocaleString("en-US")} triangles · ${measured.drawCalls} draw calls · grey figure ${PERSON_M} m · grid 1 m`,
      "left:50%;bottom:1.2%;transform:translateX(-50%);white-space:nowrap",
    );
    document.body.append(overlay);
    return { name: record.name, kind: record.kind, ...measured };
  };

  return { draw, close };
}
