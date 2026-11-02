# Brand assets

`brand/kurambit-artwork.png` is the source of truth: the ink fox on washi paper. Everything else in
this directory is rendered from it by `vp run icons:export` (Python 3 with Pillow), which separates
the ink and vermilion from the paper and composes each channel's icons:

- `brand/`: transparent fox marks for light grounds (`kurambit-mark.png`, `kurambit-head.png`) and
  dark grounds (`-light` variants), used by the web app and the marketing site
- `prod/`: release icons, ink fox on paper
- `dev/`: development builds, cream fox on ink; also copied to `apps/web/public` for the dev favicon
- `nightly/`: nightly builds, cream fox on night blue

Each family has a full-bleed `universal-1024` PNG (Linux), a `macos-1024` PNG with the classic
824-pixel body inset 100 pixels, a Windows `.ico`, and web favicons. The vermilion seal in the
corner carries the colour the fox's tail has in the artwork.

Run `vp run icons:check` to confirm the tracked files match the artwork. Do not edit the generated
files by hand; change the artwork or the script instead.
