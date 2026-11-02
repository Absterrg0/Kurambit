# Provenance: vendored three.js

- `three.module.js` + `three.core.js`: three.js r0.180.0, downloaded from
  https://unpkg.com/three@0.180.0/build/ on 2026-11-01. The module entry is a
  re-export shim: it imports `./three.core.js`, which holds the engine, so
  both files must stay together. MIT License, copyright (c) 2010-2025 three.js
  authors. Full text in `LICENSE` beside them. Imported by `../main.js`
  through a relative path, so the game needs no install step, no bundler and
  no network at runtime.
- `addons/loaders/GLTFLoader.js` + `addons/utils/BufferGeometryUtils.js`: the
  same release's `examples/jsm` files, unmodified, from the npm tarball
  three-0.180.0.tgz (sha512 integrity matches the registry) on 2026-11-03.
  They import the bare specifier `three`; the import map in `../index.html`
  points it at `./vendor/three.module.js`. Load models with
  `import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"`.
- Keep this pin. A game that needs a newer three.js says why here and vendors
  the new files with their license the same way.
