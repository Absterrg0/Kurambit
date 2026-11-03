// Shared by the social templates: the site's ink-pixel dither (see
// createInkArt in ../site/app.js), so the fox and the wordmark match
// kurambit.com cell for cell. The page marks <html data-ready> when every
// canvas is drawn; render.sh waits for it.

const INK = "#141412";
const VERMILION = "#e2582a";

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

function sample(cols, rows, paint, inkWeight) {
  const scratch = document.createElement("canvas");
  scratch.width = cols;
  scratch.height = rows;
  const context = scratch.getContext("2d", { willReadFrequently: true });
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
    if (a > 0.25 && chroma > 0.17) {
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

function draw(canvas, field, cell, { ink = INK, hot = VERMILION, gap = 1, align = "center" } = {}) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  const cells = [];
  let lowest = 0;
  for (let y = 0; y < field.rows; y += 1) {
    for (let x = 0; x < field.cols; x += 1) {
      const index = y * field.cols + x;
      if (field.density[index] > bayer(x, y)) {
        cells.push([x, y, field.accent[index]]);
        lowest = y;
      }
    }
  }
  // Stand the art on the canvas floor by its lowest inked row, not by the
  // faint wash below it in the source.
  const ox = Math.round((width - field.cols * cell) / 2);
  const oy =
    align === "bottom"
      ? height - (lowest + 1) * cell
      : Math.round((height - field.rows * cell) / 2);
  const size = cell - gap;
  const dark = new Path2D();
  const warm = new Path2D();
  for (const [x, y, accent] of cells) {
    (accent ? warm : dark).rect(ox + x * cell, oy + y * cell, size, size);
  }
  context.fillStyle = ink;
  context.fill(dark);
  context.fillStyle = hot;
  context.fill(warm);
}

function loadImage(src) {
  const image = new Image();
  image.src = src;
  return image.decode().then(() => image);
}

// Dither a picture to fit a canvas: `cell` is the pixel size, the rows follow
// from the canvas height.
async function inkImage(canvas, src, { cell, inkWeight = 0.55, curve = [0.18, 0.72], ...style }) {
  const image = await loadImage(src);
  const ratio = image.naturalWidth / image.naturalHeight;
  const fit = Math.min(canvas.clientHeight, canvas.clientWidth / ratio);
  const rows = Math.floor(fit / cell);
  const cols = Math.floor(rows * ratio);
  const field = sample(
    cols,
    rows,
    (context, w, h) => {
      // Average the brush texture, rather than pick single pixels of it.
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, w, h);
    },
    inkWeight,
  );
  if (curve) clean(field, curve);
  draw(canvas, field, cell, style);
}

// The footer's pixel wordmark: "Kurambit" in Redaction with a vermilion square
// for a full stop.
async function inkWordmark(canvas, { cell, text = "Kurambit", ...style }) {
  await document.fonts.load('400 100px "Redaction"');
  const cols = Math.floor(canvas.clientWidth / cell);
  const rows = Math.floor(canvas.clientHeight / cell);
  const field = sample(
    cols,
    rows,
    (context) => {
      context.font = '400 100px "Redaction"';
      const probe = context.measureText(text);
      const ascent = probe.actualBoundingBoxAscent;
      const square = 14;
      const scale = Math.min((rows * 0.84) / ascent, (cols * 0.96) / (probe.width + square * 1.6));
      context.font = `400 ${100 * scale}px "Redaction"`;
      const textWidth = context.measureText(text).width;
      const left = (cols - (textWidth + square * 1.6 * scale)) / 2;
      const baseline = (rows + ascent * scale) / 2;
      context.fillStyle = "#000";
      context.strokeStyle = "#000";
      context.lineWidth = 0.7;
      context.lineJoin = "round";
      context.fillText(text, left, baseline);
      context.strokeText(text, left, baseline);
      context.fillStyle = "rgb(255, 0, 0)";
      const side = square * scale;
      context.fillRect(left + textWidth + side * 0.5, baseline - side, side, side);
    },
    1,
  );
  draw(canvas, field, cell, style);
}

// Size the page from ?w=&h= so one template can serve several formats.
function sizePage(defaultWidth, defaultHeight) {
  const params = new URLSearchParams(location.search);
  const width = Number(params.get("w") ?? defaultWidth);
  const height = Number(params.get("h") ?? defaultHeight);
  document.documentElement.style.setProperty("--w", `${width}px`);
  document.documentElement.style.setProperty("--h", `${height}px`);
  for (const [key, value] of params) document.documentElement.dataset[key] = value;
  return { width, height, params };
}

async function whenDrawn(...jobs) {
  await document.fonts.ready;
  await Promise.all(jobs);
  document.documentElement.dataset.ready = "";
}

// The templates' inline scripts call these.
Object.assign(window, { inkImage, inkWordmark, sizePage, whenDrawn });
