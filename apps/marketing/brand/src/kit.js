// Shared by the brand templates: the site's ink-pixel dither (createInkArt in
// ../../site/app.js) and the few pictures the brand draws with it. The page
// marks <html data-ready> once every canvas is drawn; render.sh waits for it.

const INK = "#141412";
const VERMILION = "#e2582a";
const MOONLIT = "#efe7d6";

const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28,
  52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7,
  39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
].map((value) => (value + 0.5) / 64);
const bayer = (x, y) => BAYER[(y & 7) * 8 + (x & 7)];

const smoothstep = (a, b, v) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function hash(x, y) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Paint a picture at grid size and read it back as ink density per cell,
// plus a mask of the cells painted in the accent (red) colour.
function sample(cols, rows, paint, inkWeight = 1) {
  const scratch = document.createElement("canvas");
  scratch.width = cols;
  scratch.height = rows;
  const context = scratch.getContext("2d", { willReadFrequently: true });
  context.imageSmoothingQuality = "high";
  paint(context, cols, rows);
  const data = context.getImageData(0, 0, cols, rows).data;
  const density = new Float32Array(cols * rows);
  const accent = new Uint8Array(cols * rows);
  for (let i = 0; i < cols * rows; i += 1) {
    const [r, g, b] = [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];
    const a = data[i * 4 + 3] / 255;
    const lightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    let value = a * (1 - lightness * inkWeight);
    const chroma = (r - Math.max(g, b)) / 255;
    // A red edge stays red however faint, or it dithers into stray ink.
    if (chroma > 0.17) {
      accent[i] = 1;
      value = Math.max(value, a * chroma);
    } else if (a > 0.25 && chroma > 0.04) {
      accent[i] = 1;
      value = a * chroma;
    }
    density[i] = value;
  }
  return { cols, rows, density, accent };
}

// Push brush tones toward ink or paper and drop lone pixels, as the site does.
function clean(field, [low, high]) {
  const { cols, rows, density } = field;
  for (let i = 0; i < density.length; i += 1) density[i] = smoothstep(low, high, density[i]);
  const inked = new Uint8Array(cols * rows);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) inked[y * cols + x] = density[y * cols + x] > bayer(x, y);
  }
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      if (!inked[y * cols + x]) continue;
      let neighbours = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if ((dx || dy) && nx >= 0 && ny >= 0 && nx < cols && ny < rows) {
            neighbours += inked[ny * cols + nx];
          }
        }
      }
      if (neighbours === 0) density[y * cols + x] = 0;
    }
  }
}

function loadImage(src) {
  const image = new Image();
  image.src = src;
  return image.decode().then(() => image);
}

// Several dithered layers on one canvas, back to front. Each layer is
// { field, cell, ink, hot, ox, oy }; ox and oy place its grid in pixels.
function layers(canvas, list) {
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  const context = canvas.getContext("2d");
  for (const { field, cell, ink = INK, hot = VERMILION, ox = 0, oy = 0 } of list) {
    const size = cell - 1;
    const dark = new Path2D();
    const warm = new Path2D();
    for (let y = 0; y < field.rows; y += 1) {
      for (let x = 0; x < field.cols; x += 1) {
        const i = y * field.cols + x;
        if (field.density[i] <= bayer(x, y)) continue;
        (field.accent[i] ? warm : dark).rect(ox + x * cell, oy + y * cell, size, size);
      }
    }
    context.fillStyle = ink;
    context.fill(dark);
    context.fillStyle = hot;
    context.fill(warm);
  }
}

// A picture painted across the whole canvas grid.
function shape(canvas, cell, paint, style = {}) {
  const cols = Math.floor(canvas.clientWidth / cell);
  const rows = Math.floor(canvas.clientHeight / cell);
  return { field: sample(cols, rows, paint), cell, ...style };
}

// The fox, standing on the canvas floor by its lowest inked row. `scale` is
// its height as a share of the canvas; `at` its centre as a share of the width.
async function fox(canvas, cell, { scale = 1, at = 0.5, ink = INK } = {}) {
  const image = await loadImage("../../site/fox-ink.webp");
  const ratio = image.naturalWidth / image.naturalHeight;
  const fit = Math.min(canvas.clientHeight * scale, canvas.clientWidth / ratio);
  const rows = Math.floor(fit / cell);
  const cols = Math.floor(rows * ratio);
  const field = sample(cols, rows, (c, w, h) => c.drawImage(image, 0, 0, w, h), 0.55);
  clean(field, [0.18, 0.72]);
  let lowest = 0;
  for (let i = 0; i < field.density.length; i += 1) {
    if (field.density[i] > bayer(i % cols, (i / cols) | 0)) lowest = (i / cols) | 0;
  }
  return {
    field,
    cell,
    ink,
    ox: Math.round(canvas.clientWidth * at - (cols * cell) / 2),
    oy: canvas.clientHeight - (lowest + 1) * cell,
  };
}

function sun(context, cx, cy, r) {
  context.fillStyle = "rgb(255, 0, 0)";
  context.beginPath();
  context.arc(cx, cy, r, 0, Math.PI * 2);
  context.fill();
}

// A small platformer level in ink, the kind of build a run plays: hills, a
// tower, two ledges, a sun, and the fox as the player.
const PLAYER = ["......x.x.", "......xxx.", "xx...xxxxx", ".xxxxxxx..", "..xxxxxx..", "..x.x..x.x"];

function level(
  context,
  w,
  h,
  { sunAt = 0.74, glow = 0.12, seed = 0, sky = 0.16, hills = 0.42, player = true } = {},
) {
  // A seed moves the far ledges and hills, so builds of one game differ.
  const jitter = (k) => (seed ? (hash(seed, k) - 0.5) * 0.14 : 0);
  context.fillStyle = "#fff";
  context.fillRect(0, 0, w, h);
  // Sky: a light wash that thins toward the horizon.
  for (let y = 0; y < h * 0.62; y += 1) {
    context.fillStyle = `rgba(0, 0, 0, ${sky * (1 - y / (h * 0.62))})`;
    context.fillRect(0, y, w, 1);
  }
  if (sunAt !== null) {
    context.fillStyle = `rgba(255, 0, 0, ${glow})`;
    context.beginPath();
    context.arc(w * sunAt, h * 0.3, h * 0.24, 0, Math.PI * 2);
    context.fill();
    sun(context, w * sunAt, h * 0.3, h * 0.15);
  }
  const ridge = (x) =>
    0.5 + 0.06 * Math.sin(x * 7.1 + 1.3 + seed) + 0.03 * Math.sin(x * 17.3 + 0.2 + seed * 2);
  context.fillStyle = `rgba(0, 0, 0, ${hills})`;
  for (let x = 0; x < w; x += 1) {
    const top = ridge(x / w) * h;
    context.fillRect(x, top, 1, h - top);
  }
  context.fillStyle = "#000";
  const ledges = [
    [0, 0.34, 0.8],
    [0.44 + jitter(1) * 0.5, 0.64, 0.72 + jitter(2)],
    [0.72, 1, 0.66 + jitter(3)],
  ];
  for (const [a, b, top] of ledges) context.fillRect(a * w, top * h, (b - a) * w, h);
  if (seed % 3 !== 2) {
    const base = 0.66 + jitter(3);
    context.fillRect(w * 0.84, h * (base - 0.26), w * 0.035, h * 0.26);
    context.fillRect(w * 0.83, h * (base - 0.3), w * 0.055, h * 0.05);
  }
  if (player) sprite(context, w * 0.18, h * 0.8, Math.max(1, Math.round(h / 60)));
}

// The player sprite in vermilion, its feet at (x, y). `alpha` below 1 dithers
// it thin, for the earlier frames of a jump.
function sprite(context, x, y, unit, alpha = 1) {
  context.fillStyle = `rgba(255, 0, 0, ${alpha})`;
  PLAYER.forEach((line, row) => {
    for (let column = 0; column < line.length; column += 1) {
      if (line[column] !== "x") continue;
      context.fillRect(
        Math.round(x) + column * unit,
        Math.round(y) - (PLAYER.length - row) * unit,
        unit,
        unit,
      );
    }
  });
}

// The footer's pixel wordmark: "Kurambit" in Redaction with a vermilion
// square for a full stop.
async function wordmark(canvas, cell, style = {}) {
  await document.fonts.load('400 100px "Redaction"');
  const cols = Math.floor(canvas.clientWidth / cell);
  const rows = Math.floor(canvas.clientHeight / cell);
  const field = sample(cols, rows, (context) => {
    const text = "Kurambit";
    context.font = '400 100px "Redaction"';
    const probe = context.measureText(text);
    const ascent = probe.actualBoundingBoxAscent;
    const square = 14;
    const scale = Math.min((rows * 0.84) / ascent, (cols * 0.96) / (probe.width + square * 1.6));
    context.font = `400 ${100 * scale}px "Redaction"`;
    const width = context.measureText(text).width;
    const left = (cols - (width + square * 1.6 * scale)) / 2;
    const baseline = (rows + ascent * scale) / 2;
    context.fillStyle = "#000";
    context.strokeStyle = "#000";
    context.lineWidth = 0.7;
    context.lineJoin = "round";
    context.fillText(text, left, baseline);
    context.strokeText(text, left, baseline);
    context.fillStyle = "rgb(255, 0, 0)";
    const side = square * scale;
    context.fillRect(left + width + side * 0.5, baseline - side, side, side);
  });
  layers(canvas, [{ field, cell, ...style }]);
}

// Size the page from ?w=&h= so one template serves every format; every other
// parameter lands on <html> as data-*, for the stylesheet to read.
function sizePage(defaultWidth, defaultHeight) {
  const params = new URLSearchParams(location.search);
  const width = Number(params.get("w") ?? defaultWidth);
  const height = Number(params.get("h") ?? defaultHeight);
  const root = document.documentElement;
  root.style.setProperty("--w", `${width}px`);
  root.style.setProperty("--h", `${height}px`);
  for (const [key, value] of params) root.dataset[key] = value;
  return { width, height, params };
}

async function whenDrawn(...jobs) {
  await document.fonts.ready;
  await Promise.all(jobs);
  document.documentElement.dataset.ready = "";
}

// The templates' inline scripts call these.
Object.assign(window, {
  INK,
  VERMILION,
  MOONLIT,
  sprite,
  hash,
  layers,
  shape,
  fox,
  sun,
  level,
  wordmark,
  sizePage,
  whenDrawn,
});
