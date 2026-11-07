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
  `addons/utils/SkeletonUtils.js` (copies of skinned models for
  `shell/assets.js`): the same tarball's file, unmodified, added 2026-11-03.
  They import the bare specifier `three`; the import map in `../index.html`
  points it at `./vendor/three.module.js`. Games load models through
  `ASSETS` and `ctx.assets` (`shell/assets.js`), which uses these.
- `addons/postprocessing/{EffectComposer,Pass,RenderPass,ShaderPass,MaskPass,UnrealBloomPass,OutputPass}.js`,
  `addons/shaders/{CopyShader,LuminosityHighPassShader,OutputShader}.js` and
  `addons/environments/RoomEnvironment.js` (the look, `shell/look.js`): the
  same tarball's files, added 2026-11-06 (sha512 integrity matches the
  registry). Like the files above, they pass through the repository's code
  formatter on commit, which changes whitespace and quotes, not code.
- Keep this pin. A game that needs a newer three.js says why here and vendors
  the new files with their license the same way.

## Added for The Hill Temple

- `addons/libs/meshopt_decoder.module.js`, `addons/math/ImprovedNoise.js`: the same
  three@0.180.0 npm tarball's `examples/jsm` files, unmodified (npm pack, 2026-11-07).
- `postprocessing/index.js` + `LICENSE.md`: postprocessing 6.38.3 (pmndrs), `build/index.js` from
  its npm tarball, unmodified. Zlib License. Chosen over three's addons EffectComposer because it
  merges effects into one full-screen pass each (fewer passes on an integrated GPU).
- `n8ao/N8AO.js` + `LICENSE`: n8ao 2.0.1, `dist/N8AO.js` from its npm tarball, unmodified. Its
  package.json says ISC; its LICENSE file is CC0 1.0.
