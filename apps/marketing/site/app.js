// Kurambit site: ink-pixel art on canvas, the marked-up proofs of a run, the
// before and after of a request, and the waitlist forms. No dependencies. Every canvas repaints only on input, on
// scroll or during a short reveal, never on an idle loop.

const INK = "#141412";
const VERMILION = "#e2582a";
const GRID_DOT = "rgba(20, 20, 18, 0.16)";
const MARGIN_INK = "rgba(20, 20, 18, 0.3)";
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

for (const node of document.querySelectorAll("[data-year]")) {
  node.textContent = String(new Date().getFullYear());
}

const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const easeOut = (t) => 1 - (1 - t) ** 3;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// 8x8 Bayer matrix, normalised to thresholds in (0, 1).
const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28,
  52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7,
  39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
].map((value) => (value + 0.5) / 64);
const bayer = (x, y) => BAYER[(y & 7) * 8 + (x & 7)];

function hash2(x, y) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = x - xi;
  const v = y - yi;
  const su = u * u * (3 - 2 * u);
  const sv = v * v * (3 - 2 * v);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
}

function fitCanvas(canvas, context) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width: rect.width, height: rect.height };
}

// Paint a picture at grid resolution and read it back as ink density per
// cell, plus a mask of the cells painted in the accent colour.
function sampleField(cols, rows, paint, inkWeight = 1) {
  const scratch = document.createElement("canvas");
  scratch.width = cols;
  scratch.height = rows;
  const context = scratch.getContext("2d", { willReadFrequently: true });
  paint(context, cols, rows);
  return readField(context, cols, rows, inkWeight);
}

function readField(context, cols, rows, inkWeight = 1) {
  const data = context.getImageData(0, 0, cols, rows).data;
  const density = new Float32Array(cols * rows);
  const accent = new Uint8Array(cols * rows);
  for (let i = 0; i < cols * rows; i += 1) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const a = data[i * 4 + 3] / 255;
    const lightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    let value = a * (1 - lightness * inkWeight);
    const chroma = (r - Math.max(g, b)) / 255;
    if (a > 0.25 && chroma > 0.17) {
      accent[i] = 1;
      value = Math.max(value, a * chroma);
    } else if (a > 0.25 && chroma > 0.04) {
      // The faint edge of a glow: sparse accent, never stray ink.
      accent[i] = 1;
      value = a * chroma;
    }
    density[i] = value;
  }
  return { cols, rows, density, accent };
}

// Draw a field as square ink cells. `gate` hides cells that are not built yet;
// those show as faint grid dots when `grid` is on.
function drawField(context, field, cell, options = {}) {
  const { cols, rows, density, accent } = field;
  const { x0 = 0, x1 = Infinity, gate = null, grid = false, ox = 0, oy = 0 } = options;
  // Small cells keep no gap, or solid ink would read as grey.
  const gap = options.gap ?? (cell >= 4 ? 1 : 0);
  const size = cell - gap;
  const ink = new Path2D();
  const hot = new Path2D();
  const dots = new Path2D();
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const px = ox + x * cell;
      const py = oy + y * cell;
      if (px < x0 || px >= x1) continue;
      const threshold = bayer(x, y);
      if (gate && !gate(x, y, threshold)) {
        if (grid) dots.rect(px + cell / 2 - 0.5, py + cell / 2 - 0.5, 1, 1);
        continue;
      }
      const index = y * cols + x;
      if (density[index] > threshold) (accent[index] ? hot : ink).rect(px, py, size, size);
    }
  }
  context.fillStyle = GRID_DOT;
  context.fill(dots);
  context.fillStyle = INK;
  context.fill(ink);
  context.fillStyle = VERMILION;
  context.fill(hot);
}

function createInkArt(canvas, options) {
  const { grid, paint, inkWeight = 1, revealFrom = "top", revealMs = 1200, curve = null } = options;
  const anchor = canvas.dataset.anchor ?? "center";
  const ground = Number(canvas.dataset.ground ?? 0);
  const context = canvas.getContext("2d");
  const pointer = { x: 0, y: 0, tx: 0, ty: 0, s: 0, ts: 0 };
  let field = null;
  let cell = 0;
  let offsetX = 0;
  let offsetY = 0;
  let width = 0;
  let height = 0;
  let reveal = reduceMotion ? 1 : 0;
  let revealStart = 0;
  // How far the reveal the canvas holds has got, or null when the canvas
  // holds cells bent by the cursor and has to be redrawn whole.
  let drawnTo = null;
  let frame = 0;
  let ready = false;

  function layout() {
    const size = fitCanvas(canvas, context);
    width = size.width;
    height = size.height;
    if (!width || !height) return false;
    const shape = grid(width, height);
    cell = shape.cell;
    offsetX = Math.round((width - shape.cols * cell) / 2);
    offsetY =
      anchor === "bottom"
        ? Math.floor(height - (shape.rows + ground) * cell)
        : Math.round((height - shape.rows * cell) / 2);
    field = sampleField(shape.cols, shape.rows, paint, inkWeight);
    if (curve) clean(field, curve);
    // Sizing the canvas cleared it.
    drawnTo = -1;
    return true;
  }

  const revealOrder = (x, y, cols, rows) =>
    revealFrom === "left" ? x / cols : revealFrom === "bottom" ? 1 - y / rows : y / rows;

  // Push soft brush tones toward ink or paper, then drop pixels that would
  // stand alone: the dither keeps the stroke and loses the noise.
  function clean({ cols, rows, density }, [low, high]) {
    for (let i = 0; i < density.length; i += 1) density[i] = smoothstep(low, high, density[i]);
    const inked = new Uint8Array(cols * rows);
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        inked[y * cols + x] = density[y * cols + x] > bayer(x, y) ? 1 : 0;
      }
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

  // A few rows of dithered earth under the art, thinning toward the sides.
  function drawGround(ink) {
    const size = cell - 1;
    const top = offsetY + field.rows * cell;
    const firstColumn = -Math.ceil(offsetX / cell);
    const lastColumn = Math.ceil((width - offsetX) / cell);
    const shown = reveal >= 1 ? 1 : clamp(reveal * 3);
    // A cast shadow: an ellipse a little wider than the art, thinning downward.
    const reach = field.cols * cell * 0.62;
    for (let row = 0; row < ground; row += 1) {
      const weight = [0.85, 0.5, 0.22][row] ?? 0.1;
      const rowReach = reach * Math.sqrt(1 - (row / (ground + 0.5)) ** 2);
      for (let column = firstColumn; column < lastColumn; column += 1) {
        const px = offsetX + column * cell;
        const spread = 1 - (Math.abs(px + cell / 2 - width / 2) / rowReach) ** 2;
        const value = clamp(spread) * weight * shown;
        if (value > bayer(column + 64, row)) ink.rect(px, top + row * cell, size, size);
      }
    }
  }

  function draw() {
    context.clearRect(0, 0, width, height);
    if (!field) return;
    const { cols, rows, density, accent } = field;
    const size = cell - 1;
    const radius = cell * 11;
    const radius2 = radius * radius;
    const strength = pointer.s;
    const push = cell * 1.4 * strength;
    const ink = new Path2D();
    const hot = new Path2D();
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const index = y * cols + x;
        const value = density[index];
        if (value < 0.02) continue;
        const threshold = bayer(x, y);
        if (value <= threshold) continue;
        if (reveal < 1 && reveal * 1.5 - revealOrder(x, y, cols, rows) - threshold * 0.5 < 0) {
          continue;
        }
        let px = offsetX + x * cell;
        let py = offsetY + y * cell;
        if (strength > 0.002) {
          const dx = px + cell / 2 - pointer.x;
          const dy = py + cell / 2 - pointer.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < radius2) {
            const distance = Math.sqrt(d2) || 1;
            const falloff = 1 - d2 / radius2;
            const shift = falloff * falloff * push;
            px += (dx / distance) * shift;
            py += (dy / distance) * shift;
          }
        }
        (accent[index] ? hot : ink).rect(Math.round(px), Math.round(py), size, size);
      }
    }
    if (ground) drawGround(ink);
    context.fillStyle = INK;
    context.fill(ink);
    context.fillStyle = VERMILION;
    context.fill(hot);
    drawnTo = strength > 0.002 || ground ? null : reveal;
  }

  // A reveal frame paints only the cells that arrive in it, on top of the
  // ones already there. Repainting every cell each frame kept a phone's main
  // thread busy for the whole reveal.
  function drawArrivals() {
    const { cols, rows, density, accent } = field;
    const size = cell - 1;
    const ink = new Path2D();
    const hot = new Path2D();
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const index = y * cols + x;
        const value = density[index];
        const threshold = bayer(x, y);
        if (value < 0.02 || value <= threshold) continue;
        const arrives = (revealOrder(x, y, cols, rows) + threshold * 0.5) / 1.5;
        if (arrives <= drawnTo || arrives > reveal) continue;
        (accent[index] ? hot : ink).rect(offsetX + x * cell, offsetY + y * cell, size, size);
      }
    }
    context.fillStyle = INK;
    context.fill(ink);
    context.fillStyle = VERMILION;
    context.fill(hot);
    drawnTo = reveal;
  }

  function tick(now) {
    frame = 0;
    let busy = false;
    if (reveal < 1) {
      reveal = easeOut(clamp((now - revealStart) / revealMs));
      busy = reveal < 1;
    }
    pointer.x += (pointer.tx - pointer.x) * 0.32;
    pointer.y += (pointer.ty - pointer.y) * 0.32;
    pointer.s += (pointer.ts - pointer.s) * 0.14;
    const settled =
      Math.abs(pointer.ts - pointer.s) < 0.004 &&
      Math.abs(pointer.tx - pointer.x) < 0.5 &&
      Math.abs(pointer.ty - pointer.y) < 0.5;
    if (settled) pointer.s = pointer.ts;
    else busy = true;
    if (drawnTo !== null && pointer.s <= 0.002 && !ground) drawArrivals();
    else draw();
    if (busy) frame = requestAnimationFrame(tick);
  }

  function schedule() {
    if (ready && !frame) frame = requestAnimationFrame(tick);
  }

  if (!reduceMotion) {
    canvas.addEventListener("pointermove", (event) => {
      const rect = canvas.getBoundingClientRect();
      pointer.tx = event.clientX - rect.left;
      pointer.ty = event.clientY - rect.top;
      if (pointer.s < 0.01) {
        pointer.x = pointer.tx;
        pointer.y = pointer.ty;
      }
      pointer.ts = 1;
      schedule();
    });
    canvas.addEventListener("pointerleave", () => {
      pointer.ts = 0;
      schedule();
    });
  }

  return {
    start() {
      if (!layout()) return;
      ready = true;
      revealStart = performance.now();
      if (reveal < 1) schedule();
      else draw();
    },
    resize() {
      if (ready && layout()) draw();
    },
  };
}

const resizers = [];
let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const resize of resizers) resize();
  }, 140);
});

function whenVisible(element, callback, rootMargin = "0px") {
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        callback();
      }
    },
    { rootMargin },
  );
  observer.observe(element);
}

const foxCanvas = document.getElementById("fox");
if (foxCanvas) {
  const image = new Image();
  image.decoding = "async";
  const fox = createInkArt(foxCanvas, {
    inkWeight: 0.55,
    curve: [0.18, 0.72],
    revealFrom: "bottom",
    revealMs: 1300,
    grid(width, height) {
      const ratio = image.naturalWidth / image.naturalHeight;
      const ground = Number(foxCanvas.dataset.ground ?? 0);
      const rowsWanted = Number(foxCanvas.dataset.rows ?? 100);
      const room = height - Math.max(24, height * 0.06);
      const cell = Math.max(3, Math.round(room / rowsWanted));
      const foxHeight = Math.min(room - ground * cell, ((width - 16) / ratio) | 0);
      const cols = Math.floor((foxHeight * ratio) / cell);
      return { cols, rows: Math.floor(cols / ratio), cell };
    },
    paint(context, cols, rows) {
      context.drawImage(image, 0, 0, cols, rows);
    },
  });
  // The headline paints first: the 120 KB picture the fox is sampled from
  // would otherwise compete with the fonts on a slow connection.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      image.src = "fox-ink.webp";
      image.decode().then(
        () => fox.start(),
        () => {},
      );
    }),
  );
  resizers.push(() => fox.resize());
}

const wordmarkCanvas = document.querySelector("[data-wordmark]");
if (wordmarkCanvas) {
  const wordmark = createInkArt(wordmarkCanvas, {
    revealFrom: "left",
    revealMs: 1100,
    grid(width, height) {
      const cell = Math.max(4, Math.round(width / 220));
      return { cols: Math.floor(width / cell), rows: Math.floor(height / cell), cell };
    },
    paint(context, cols, rows) {
      const text = "Kurambit";
      context.font = '400 100px "Redaction", "Times New Roman", serif';
      const probe = context.measureText(text);
      const ascent = probe.actualBoundingBoxAscent;
      const square = 14;
      const scale = Math.min((rows * 0.84) / ascent, (cols * 0.94) / (probe.width + square * 1.6));
      context.font = `400 ${100 * scale}px "Redaction", "Times New Roman", serif`;
      const textWidth = context.measureText(text).width;
      const total = textWidth + square * 1.6 * scale;
      const left = (cols - total) / 2;
      const baseline = (rows + ascent * scale) / 2;
      // Hairline serifs vanish at this size, so thicken every stroke a little.
      context.fillStyle = "#000";
      context.strokeStyle = "#000";
      context.lineWidth = 0.7;
      context.lineJoin = "round";
      context.fillText(text, left, baseline);
      context.strokeText(text, left, baseline);
      // The brand's vermilion square sits on the baseline like a full stop.
      context.fillStyle = "rgb(255, 0, 0)";
      const side = square * scale;
      context.fillRect(left + textWidth + side * 0.5, baseline - side, side, side);
    },
  });
  whenVisible(
    wordmarkCanvas,
    () => {
      document.fonts.load('400 100px "Redaction"').finally(() => wordmark.start());
    },
    "0px 0px -10% 0px",
  );
  resizers.push(() => wordmark.resize());
}

function startMargins(canvas, page) {
  const context = canvas.getContext("2d");
  const CELL = 4;
  const GLOW = 120;
  let width = 0;
  let height = 0;
  let left = 0;
  let right = 0;
  let pointer = null;
  let frame = 0;

  function layout() {
    const size = fitCanvas(canvas, context);
    width = size.width;
    height = size.height;
    const rect = page.getBoundingClientRect();
    left = rect.left;
    right = rect.right;
  }

  function band(ink, hot, x0, x1, edge, shift) {
    const firstRow = Math.floor(shift / CELL);
    const lastRow = Math.ceil((shift + height) / CELL);
    for (let column = Math.floor(x0 / CELL); column * CELL < x1; column += 1) {
      const x = column * CELL;
      const distance = Math.abs(x + CELL / 2 - edge);
      const ramp = clamp((distance - 6) / 150);
      if (ramp <= 0) continue;
      for (let row = firstRow; row <= lastRow; row += 1) {
        const worldY = row * CELL;
        const cloud =
          0.62 * valueNoise(x / 150, worldY / 150) + 0.38 * valueNoise(x / 48, worldY / 48);
        let value = ramp * (0.06 + 0.62 * smoothstep(0.32, 0.82, cloud));
        let near = 0;
        if (pointer) {
          const dx = x - pointer.x;
          const dy = worldY - shift - pointer.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < GLOW) {
            near = 1 - d / GLOW;
            value += near * near * 0.7;
          }
        }
        if (value > bayer(column, row)) {
          (near > 0.12 ? hot : ink).rect(x, worldY - shift, 2, 2);
        }
      }
    }
  }

  function draw() {
    frame = 0;
    context.clearRect(0, 0, width, height);
    if (left < 6) return;
    const shift = reduceMotion ? 0 : Math.round(window.scrollY * 0.3);
    const ink = new Path2D();
    const hot = new Path2D();
    band(ink, hot, 0, left - 1, left, shift);
    band(ink, hot, right + 1, width, right, shift);
    context.fillStyle = MARGIN_INK;
    context.fill(ink);
    context.fillStyle = VERMILION;
    context.fill(hot);
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  layout();
  draw();
  resizers.push(() => {
    layout();
    draw();
  });
  if (!reduceMotion) {
    window.addEventListener(
      "pointermove",
      (event) => {
        const inMargin = event.clientX < left || event.clientX > right;
        if (inMargin) {
          pointer = { x: event.clientX, y: event.clientY };
          schedule();
        } else if (pointer) {
          pointer = null;
          schedule();
        }
      },
      { passive: true },
    );
    document.documentElement.addEventListener("pointerleave", () => {
      pointer = null;
      schedule();
    });
  }
  return { onScroll: reduceMotion ? () => {} : schedule };
}

const marginCanvas = document.querySelector("[data-margin]");
const pageNode = document.querySelector(".page");
const margins = marginCanvas && pageNode ? startMargins(marginCanvas, pageNode) : null;

const PLATFORMS = [
  [0, 0.33, 0.8],
  [0.43, 0.63, 0.73],
  [0.71, 1, 0.66],
];
const TOWER_X = 0.86;
// The playtester: a small fox, facing right, drawn cell by cell.
const FOX_SPRITE = [
  "......x.x.",
  "......xxx.",
  "xx...xxxxx",
  ".xxxxxxx..",
  "..xxxxxx..",
  "..x.x..x.x",
];

function drawSprite(fill, footX, footY) {
  FOX_SPRITE.forEach((line, row) => {
    for (let column = 0; column < line.length; column += 1) {
      if (line[column] === "x") fill(footX - 5 + column, footY - FOX_SPRITE.length + row);
    }
  });
}

const ridgeAt = (x) =>
  0.46 +
  0.06 * Math.sin(x * 7.1 + 1.3) +
  0.035 * Math.sin(x * 17.3 + 0.2) +
  0.014 * Math.sin(x * 43.1);
const hillAt = (x) => 0.6 + 0.045 * Math.sin(x * 4.3 + 0.4) + 0.02 * Math.sin(x * 12.7 + 2.1);

function paintValley(context, W, H, scene) {
  context.fillStyle = "#fff";
  context.fillRect(0, 0, W, H);

  if (scene.stars) {
    context.fillStyle = "#000";
    for (let i = 0; i < 22; i += 1) {
      context.fillRect(Math.floor(hash2(i, 7) * W), Math.floor(hash2(i, 11) * H * 0.36), 1, 1);
    }
  }

  // Snow falls as small ink crosses in the sky; the ridge gets its caps below.
  if (scene.snow) {
    context.fillStyle = "#000";
    const unit = Math.max(1, Math.round(H / 110));
    for (let i = 0; i < 12; i += 1) {
      const x = Math.round(hash2(i, 23) * W);
      const y = Math.round(hash2(i, 29) * H * 0.36);
      context.fillRect(x - unit, y, unit * 3, unit);
      context.fillRect(x, y - unit, unit, unit * 3);
    }
  }

  const moonX = W * 0.62;
  const moonless = scene.moon === "none";
  const moonY = H * 0.27;
  const moonR = Math.max(2, H * 0.11);
  if (moonless) {
    // A crop that would only catch the moon's edge leaves it out.
  } else if (scene.moon === "red") {
    const glow = context.createRadialGradient(moonX, moonY, moonR, moonX, moonY, moonR * 1.7);
    glow.addColorStop(0, "rgba(255, 0, 0, 0.45)");
    glow.addColorStop(1, "rgba(255, 0, 0, 0)");
    context.fillStyle = glow;
    context.fillRect(0, 0, W, H);
    context.fillStyle = "rgb(255, 0, 0)";
  } else {
    context.fillStyle = "rgb(175, 175, 175)";
  }
  if (!moonless) {
    context.beginPath();
    context.arc(moonX, moonY, moonR, 0, Math.PI * 2);
    context.fill();
  }

  context.beginPath();
  context.moveTo(0, H);
  for (let x = 0; x <= W; x += 1) context.lineTo(x, ridgeAt(x / W) * H);
  context.lineTo(W, H);
  context.closePath();
  if (!scene.flat) {
    // Colder rounds darken the ridge so its snowcaps read as paper.
    context.fillStyle = scene.snow ? "rgb(120, 120, 120)" : "rgb(228, 228, 228)";
    context.fill();
  }
  if (scene.snow) {
    context.save();
    context.clip();
    context.fillStyle = "#fff";
    context.fillRect(0, 0, W, H * 0.47);
    context.restore();
    // The caps are paper against a paper sky; an inked outline shows them.
    context.beginPath();
    for (let x = 0; x <= W; x += 1) {
      const y = ridgeAt(x / W) * H;
      if (x) context.lineTo(x, y);
      else context.moveTo(x, y);
    }
    context.strokeStyle = "#000";
    context.lineWidth = Math.max(1, H * 0.009);
    context.stroke();
  }

  context.beginPath();
  context.moveTo(0, H);
  for (let x = 0; x <= W; x += 1) context.lineTo(x, hillAt(x / W) * H);
  context.lineTo(W, H);
  context.closePath();
  context.fillStyle = "rgb(198, 198, 198)";
  context.fill();

  if (scene.trees) {
    context.fillStyle = "#000";
    const count = Math.round(scene.trees * 26);
    for (let i = 0; i < count; i += 1) {
      const x = hash2(i, 3) * 0.78;
      const base = hillAt(x) * H + 1;
      const tall = H * (0.05 + hash2(i, 5) * 0.045);
      context.beginPath();
      context.moveTo(x * W, base - tall);
      context.lineTo(x * W - tall * 0.4, base);
      context.lineTo(x * W + tall * 0.4, base);
      context.fill();
    }
  }

  PLATFORMS.forEach(([from, to, top], index) => {
    if (scene.broken && index === 1) return;
    const left = Math.round(from * W);
    const span = Math.ceil((to - from) * W);
    const lip = Math.max(1, Math.round(H * 0.035));
    context.fillStyle = "rgb(42, 42, 42)";
    context.fillRect(left, Math.round(top * H) + lip, span, H);
    context.fillStyle = "#000";
    context.fillRect(left, Math.round(top * H), span, lip);
  });
  context.fillStyle = "#000";
  if (scene.bridge) {
    const [, start] = PLATFORMS[0];
    const [end] = PLATFORMS[1];
    const deck = PLATFORMS[0][2] * H;
    const span = (end - start) * W;
    context.beginPath();
    context.moveTo(start * W, deck);
    context.lineTo(end * W, deck);
    context.lineTo(end * W, deck + H * 0.09);
    context.quadraticCurveTo(start * W + span / 2, deck + H * 0.005, start * W, deck + H * 0.09);
    context.fill();
    context.fillRect(start * W, deck - H * 0.035, span, Math.max(1, H * 0.006));
    for (let post = 0; post <= 4; post += 1) {
      context.fillRect(start * W + (span - 1) * (post / 4), deck - H * 0.035, 1, H * 0.035);
    }
  }

  const towerX = TOWER_X * W;
  const towerTop = H * 0.41;
  const towerBase = PLATFORMS[2][2] * H;
  const baseHalf = Math.max(1.5, W * 0.022);
  const topHalf = Math.max(1, W * 0.015);
  context.beginPath();
  context.moveTo(towerX - baseHalf, towerBase + 1);
  context.lineTo(towerX - topHalf, towerTop);
  context.lineTo(towerX + topHalf, towerTop);
  context.lineTo(towerX + baseHalf, towerBase + 1);
  context.fill();
  context.beginPath();
  context.moveTo(towerX - topHalf * 1.7, towerTop);
  context.lineTo(towerX, towerTop - H * 0.065);
  context.lineTo(towerX + topHalf * 1.7, towerTop);
  context.fill();
  const lampY = towerTop + H * 0.03;
  if (scene.lantern) {
    const glow = context.createRadialGradient(towerX, lampY, 0, towerX, lampY, H * 0.13);
    glow.addColorStop(0, "rgba(255, 40, 20, 0.55)");
    glow.addColorStop(1, "rgba(255, 40, 20, 0)");
    context.fillStyle = glow;
    context.fillRect(0, 0, W, H);
    context.fillStyle = "rgb(255, 0, 0)";
  } else {
    context.fillStyle = "#fff";
  }
  context.fillRect(towerX - topHalf * 0.6, lampY - H * 0.018, topHalf * 1.2, H * 0.036);

  if (scene.fox) {
    context.fillStyle = "#fff";
    const footX = Math.round(scene.fox[0] * W);
    const footY = Math.round(scene.fox[1] * H);
    context.fillRect(footX - 6, footY - 7, 12, 7);
    context.fillStyle = "rgb(255, 0, 0)";
    drawSprite((x, y) => context.fillRect(x, y, 1, 1), footX, footY);
  }

  if (scene.dark) {
    context.fillStyle = "rgba(0, 0, 0, 0.4)";
    context.fillRect(0, 0, W, H);
  }
}

const SCENES = {};
SCENES.older = { moon: "gray", flat: true };
SCENES.first = { moon: "red", trees: 0.3 };
SCENES.lit = { ...SCENES.first, lantern: true };
SCENES.snow = { ...SCENES.lit, snow: true };
SCENES.stars = { ...SCENES.snow, stars: true };
SCENES.forest = { ...SCENES.stars, trees: 0.7 };
SCENES.brokenLit = { ...SCENES.lit, broken: true };

// Where the playtester is at u in [0, 1]: walking, then jumping each gap.
function testerAt(u) {
  const x = 0.05 + u * 0.74;
  const jumps = [
    [0.29, 0.47, PLATFORMS[0][2], PLATFORMS[1][2]],
    [0.59, 0.75, PLATFORMS[1][2], PLATFORMS[2][2]],
  ];
  for (const [from, to, y0, y1] of jumps) {
    if (x >= from && x <= to) {
      const s = (x - from) / (to - from);
      return { x, y: y0 + (y1 - y0) * s - Math.sin(Math.PI * s) * 0.15 };
    }
  }
  const platform = PLATFORMS.find(([from, to]) => x >= from && x <= to) ?? PLATFORMS[2];
  return { x, y: platform[2] };
}

// The run: a desk with one proof on it. Scrolling plays it: the tester runs
// the build, the red pen marks it, and the judge compares it blind.

const SVG_NS = "http://www.w3.org/2000/svg";
const FRAME_W = 1000;
const FRAME_H = 630;

// A loop drawn by hand: it overshoots its start and grows a little as it goes.
function roughRing(cx, cy, rx, ry, seed, turns = 1.12) {
  const start = hash2(seed, 1) * Math.PI * 2;
  const wobble = hash2(seed, 2) * 6;
  let d = "";
  for (let i = 0; i <= 72; i += 1) {
    const t = start + (i / 72) * turns * Math.PI * 2;
    const grow = 1 + 0.035 * Math.sin(t * 2 + wobble) + (i / 72) * 0.07;
    d += `${i ? "L" : "M"}${(cx + Math.cos(t) * rx * grow).toFixed(1)} ${(cy + Math.sin(t) * ry * grow).toFixed(1)}`;
  }
  return d;
}

const tickPath = ([x, y]) => `M${x - 16} ${y - 2}L${x - 4} ${y + 12}L${x + 22} ${y - 20}`;
const crossPath = (x) =>
  `M${x - 16} ${FRAME_H - 54}L${x + 16} ${FRAME_H - 22}M${x + 15} ${FRAME_H - 56}L${x - 15} ${FRAME_H - 20}`;

function svgNode(parent, tag, attributes = {}) {
  const node = parent.appendChild(document.createElementNS(SVG_NS, tag));
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

// The tester's attempts as points in frame units: the full route, or three
// tries at a gap that is too wide, each falling short.
function attemptsFor(kind) {
  const steps = 96;
  if (kind === "route") {
    return [
      Array.from({ length: steps + 1 }, (_, i) => {
        const point = testerAt(i / steps);
        return [point.x * FRAME_W, point.y * FRAME_H];
      }),
    ];
  }
  return [0.47, 0.52, 0.56].map((land) =>
    Array.from({ length: steps + 1 }, (_, i) => {
      const u = i / steps;
      if (u < 0.45) return [(0.05 + (u / 0.45) * 0.25) * FRAME_W, PLATFORMS[0][2] * FRAME_H];
      const s = (u - 0.45) / 0.55;
      return [(0.3 + (land - 0.3) * s) * FRAME_W, (0.8 - 0.42 * s + 0.75 * s * s) * FRAME_H];
    }),
  );
}

// The desk's parts, each a pure function of one clock. Scrolling sets the
// clock, so a frame looks the same whether you got there going down or up.
function createTimeline() {
  let tasks = [];
  let sorted = true;
  return {
    add(at, duration, update, pen = false) {
      tasks.push({ at, duration: Math.max(1, duration), update, pen });
      sorted = false;
    },
    get end() {
      return tasks.reduce((end, task) => Math.max(end, task.at + task.duration), 0);
    },
    seek(time) {
      if (!sorted) {
        tasks.sort((a, b) => a.at - b.at);
        sorted = true;
      }
      for (const task of tasks) {
        const t = (time - task.at) / task.duration;
        // There is one pen: only the jobs that have begun may move it, and
        // the latest of them wins.
        if (task.pen && t < 0) continue;
        task.update(clamp(t));
      }
    },
    clear() {
      tasks = [];
    },
  };
}

// Two builds of one run: one that wins its blind compare, one that loses.
const PROOFS = [
  {
    number: 2,
    scene: SCENES.lit,
    commit: "9c03e5a",
    seconds: 49,
    trail: "route",
    log: [
      [0, "Starts on the left ledge"],
      [0.08, "Sees the lantern at once"],
      [0.32, "First jump lands"],
      [0.62, "Second jump lands"],
      [1, "Lights the lantern"],
    ],
    marks: [
      { at: 0.1, ring: [860, 262, 66, 104], note: ["reads now", 64, 6] },
      { at: 0.34, tick: [548, 404], note: ["lands", 57, 58] },
    ],
    judge: {
      before: SCENES.first,
      beforeName: "build 1",
      winner: "B",
      verdict: "B wins in both orders. Build 2 is kept.",
    },
    stamp: ["Kept", 4.5, 7, -6],
  },
  {
    number: 3,
    scene: SCENES.brokenLit,
    commit: "e71fa2c",
    seconds: 31,
    trail: "fall",
    log: [
      [0, "Starts on the left ledge"],
      [0.33, "Falls into the gap", "bad"],
      [0.66, "Falls into the gap", "bad"],
      [1, "Falls into the gap", "bad"],
      [1, "Stops: the gap is too wide"],
    ],
    marks: [{ at: 1, ring: [520, 548, 112, 62], note: ["too wide, ×3", 38, 41] }],
    judge: {
      before: SCENES.lit,
      beforeName: "build 2",
      winner: "A",
      verdict: "A wins in both orders. Build 3 is thrown away.",
    },
    stamp: ["Thrown away", 4.5, 7, -9],
  },
];

// How much of each build's stretch of scroll plays it; the rest holds the
// finished proof before the next one lands.
const PROOF_PLAY = 0.82;

function startProofs(root) {
  const pin = root.querySelector(".proof-pin");
  const desk = root.querySelector("[data-desk]");
  const stack = root.querySelector(".stack");
  const proof = root.querySelector("[data-proof]");
  const canvas = root.querySelector("[data-proof-canvas]");
  const context = canvas.getContext("2d");
  const marks = root.querySelector("[data-proof-marks]");
  const scrawls = root.querySelector("[data-scrawls]");
  const stamp = root.querySelector("[data-stamp]");
  const stampText = root.querySelector("[data-stamp-text]");
  const pile = root.querySelector("[data-pile]");
  const name = root.querySelector("[data-proof-name]");
  const commit = root.querySelector("[data-proof-commit]");
  const rec = root.querySelector("[data-rec]");
  const recTime = root.querySelector("[data-rec-time]");
  const log = root.querySelector("[data-log]");
  const thumbs = [...root.querySelectorAll("[data-thumb]")];
  const orders = [...root.querySelectorAll("[data-orders] li")];
  const verdict = root.querySelector("[data-verdict]");
  const layer = root.querySelector("[data-desk-layer]");
  const pen = root.querySelector("[data-pen]");
  const press = root.querySelector("[data-press]");
  const index = root.querySelector("[data-proof-index]");
  const timeline = createTimeline();
  const cache = new Map();
  let width = 0;
  let cell = 4;
  let step = -1;
  let last = -1;
  let visible = false;
  let rest = [0, 0];
  let tucked = false;

  const travel = () => root.getBoundingClientRect().height - pin.offsetHeight;
  const items = PROOFS.map((data, i) => {
    const item = index.appendChild(document.createElement("li"));
    item.toggleAttribute("data-thrown", data.stamp[0] !== "Kept");
    const button = item.appendChild(document.createElement("button"));
    button.type = "button";
    button.append(document.createElement("i"), `Build ${data.number}`);
    button.addEventListener("click", () => {
      const pinTop = parseFloat(getComputedStyle(pin).top) || 0;
      const top = root.getBoundingClientRect().top + window.scrollY - pinTop;
      const target = top + ((i + PROOF_PLAY) / PROOFS.length) * travel();
      window.scrollTo({ top: target, behavior: reduceMotion ? "auto" : "smooth" });
    });
    return item;
  });
  const more = index.appendChild(document.createElement("li"));
  more.className = "more";
  more.textContent = "and on, until the budget ends";

  function field(scene, w, h, size) {
    const cols = Math.ceil(w / size);
    const rows = Math.ceil(h / size);
    const key = `${cols}x${rows}:${JSON.stringify(scene)}`;
    if (!cache.has(key)) {
      cache.set(
        key,
        sampleField(cols, rows, (c, cw, ch) => paintValley(c, cw, ch, scene)),
      );
    }
    return cache.get(key);
  }

  function paintThumb(thumb, scene) {
    const target = thumb.querySelector("canvas");
    const thumbContext = target.getContext("2d");
    const size = fitCanvas(target, thumbContext);
    thumbContext.clearRect(0, 0, size.width, size.height);
    const thumbCell = Math.max(2, Math.round(size.width / 64));
    drawField(thumbContext, field(scene, size.width, size.height, thumbCell), thumbCell, {
      gap: 0,
    });
  }

  function layout() {
    width = fitCanvas(canvas, context).width;
    cell = Math.max(3, Math.round(width / 160));
    cache.clear();
  }

  // At rest the pen lies nearly flat beside the proof; it turns up to write.
  const REST_TURN = 40;
  const placePen = ([x, y], lift = 0, turn = 0) => {
    pen.setAttribute(
      "transform",
      `translate(${x.toFixed(1)} ${(y - lift).toFixed(1)}) rotate(${turn.toFixed(1)})`,
    );
  };

  // Lays out one build and plans every part of it on the timeline.
  function setup(next) {
    timeline.clear();
    const data = PROOFS[next];
    step = next;
    last = -1;
    proof.style.transform = "";
    proof.style.opacity = "1";
    const deskBox = desk.getBoundingClientRect();
    layer.setAttribute("viewBox", `0 0 ${deskBox.width} ${deskBox.height}`);
    const frameBox = canvas.getBoundingClientRect();
    const stackBox = stack.getBoundingClientRect();
    const scale = frameBox.width / FRAME_W;
    const toDesk = ([fx, fy]) => [
      frameBox.left - deskBox.left + fx * scale,
      frameBox.top - deskBox.top + fy * scale,
    ];
    rest = [
      stackBox.left - deskBox.left + stackBox.width * 0.34,
      stackBox.bottom - deskBox.top + 20,
    ];
    tucked = window.matchMedia("(max-width: 900px)").matches;
    let penAt = rest;
    let penTurn = REST_TURN;
    let penFree = 0;

    items.forEach((item, i) => {
      item.toggleAttribute("data-active", i === next);
      item.toggleAttribute("data-judged", i < next);
    });
    pile.dataset.count = String(Math.min(data.number - 1, 3));
    name.textContent = `Build ${data.number}`;
    commit.textContent = data.commit;
    context.clearRect(0, 0, frameBox.width, frameBox.height);
    drawField(context, field(data.scene, frameBox.width, frameBox.height, cell), cell);
    marks.replaceChildren();
    scrawls.replaceChildren();
    log.replaceChildren();

    // A later proof lands on the pile as its stretch of scroll begins.
    if (next > 0) {
      timeline.add(0, 420, (t) => {
        const e = easeOut(t);
        proof.style.opacity = String(Math.min(1, t * 2));
        proof.style.transform =
          t < 1
            ? `translateY(${(-18 * (1 - e)).toFixed(1)}px) rotate(${(0.8 * (1 - e)).toFixed(2)}deg)`
            : "";
      });
    }

    stampText.replaceChildren();
    const words = data.stamp[0].split(" ");
    words.forEach((word, i) => {
      const line = svgNode(stampText, "tspan", { x: 60, y: words.length > 1 ? 55 + i * 26 : 69 });
      line.textContent = word;
    });
    stamp.style.left = `${data.stamp[1]}%`;
    stamp.style.top = `${data.stamp[2]}%`;
    stamp.style.setProperty("--r", `${data.stamp[3]}deg`);

    // The tester plays, and the log fills in step with the run.
    const playAt = next > 0 ? 480 : 160;
    const playFor = data.trail === "fall" ? 2700 : 2400;
    for (const [u, text, kind] of data.log) {
      const entry = log.appendChild(document.createElement("li"));
      if (kind === "bad") entry.className = "is-bad";
      const time = entry.appendChild(document.createElement("time"));
      time.textContent = `0:${String(Math.round(u * data.seconds)).padStart(2, "0")}`;
      entry.appendChild(document.createElement("span")).textContent = text;
      timeline.add(playAt + u * playFor, 260, (t) => {
        entry.style.opacity = String(t);
        entry.style.transform = t < 1 ? `translateY(${(4 * (1 - t)).toFixed(1)}px)` : "";
      });
    }
    timeline.add(playAt, playFor, (t) => {
      rec.toggleAttribute("data-live", t > 0 && t < 1);
      recTime.textContent = `0:${String(Math.round(t * data.seconds)).padStart(2, "0")}`;
    });

    const unit = (cell * FRAME_W) / frameBox.width;
    const attempts = attemptsFor(data.trail);
    const dotsGroup = svgNode(marks, "g", { class: "trail" });
    const dots = attempts.map((points) => {
      const list = [];
      let previous = null;
      points.forEach(([x, y], i) => {
        const gx = Math.round(x / unit);
        if (gx === previous || gx % 2 || y > FRAME_H) return;
        previous = gx;
        const dot = svgNode(dotsGroup, "rect", {
          x: (gx * unit).toFixed(1),
          y: ((Math.round(y / unit) - 2) * unit).toFixed(1),
          width: (unit * 0.8).toFixed(1),
          height: (unit * 0.8).toFixed(1),
          opacity: 0,
        });
        list.push({ dot, u: i / (points.length - 1) });
      });
      return list;
    });
    const fox = svgNode(marks, "g", { class: "fox" });
    svgNode(fox, "rect", {
      class: "fox-back",
      x: -unit,
      y: -unit,
      width: 12 * unit,
      height: 7 * unit,
    });
    drawSprite(
      (x, y) => {
        svgNode(fox, "rect", { x: x * unit, y: y * unit, width: unit * 0.85, height: unit * 0.85 });
      },
      5,
      6,
    );
    const placeFox = (attempt, u) => {
      const points = attempts[attempt];
      const [x, y] = points[Math.round(u * (points.length - 1))];
      const fx = Math.round(x / unit) * unit;
      const fy = Math.round(y / unit) * unit;
      fox.setAttribute(
        "transform",
        `translate(${(fx - 5 * unit).toFixed(1)} ${(fy - 6 * unit).toFixed(1)})`,
      );
    };
    timeline.add(playAt, playFor, (t) => {
      const along = t * attempts.length;
      const attempt = Math.min(attempts.length - 1, Math.floor(along));
      const raw = t === 1 ? 1 : along - attempt;
      const u = data.trail === "route" ? easeInOut(raw) : raw;
      dots.forEach((list, k) => {
        for (const { dot, u: at } of list) {
          dot.setAttribute(
            "opacity",
            t > 0 && (k < attempt || (k === attempt && at <= u)) ? "1" : "0",
          );
        }
      });
      if (t === 1 && data.trail === "fall") placeFox(0, 0.4);
      else placeFox(attempt, u);
    });

    // The red pen: it glides to each mark, draws it, writes its note, and
    // goes back to rest beside the proof. `tip` says where the nib is at t;
    // `draw` puts the ink down behind it.
    const penJob = (want, length, tip, draw) => {
      const at = Math.max(want, penFree);
      const glide = penTurn ? 420 : 240;
      const from = penAt;
      const turnFrom = penTurn;
      const start = tip(0);
      timeline.add(
        at,
        glide,
        (t) => {
          const e = easeInOut(t);
          placePen(
            [from[0] + (start[0] - from[0]) * e, from[1] + (start[1] - from[1]) * e],
            Math.sin(Math.PI * t) * 10,
            turnFrom * (1 - e),
          );
          if (tucked && turnFrom) pen.style.opacity = String(t);
        },
        true,
      );
      timeline.add(at + glide, length, (t) => placePen(tip(t)), true);
      timeline.add(at + glide, length, draw);
      penTurn = 0;
      penAt = tip(1);
      penFree = at + glide + length + 80;
    };
    const ink = (d, want, length = 520) => {
      const path = svgNode(marks, "path", { class: "mark", d });
      const total = path.getTotalLength();
      path.style.strokeDasharray = String(total);
      penJob(
        want,
        length,
        (t) => {
          const point = path.getPointAtLength(total * t);
          return toDesk([point.x, point.y]);
        },
        (t) => {
          path.style.strokeDashoffset = String(total * (1 - t));
        },
      );
    };
    const write = (text, left, top, want) => {
      const note = scrawls.appendChild(document.createElement("span"));
      note.className = "scrawl";
      note.textContent = text;
      note.style.left = `${left}%`;
      note.style.top = `${top}%`;
      const box = note.getBoundingClientRect();
      const baseY = box.bottom - deskBox.top - box.height * 0.22;
      const x0 = box.left - deskBox.left;
      penJob(
        want,
        120 + text.length * 26,
        (t) => [x0 + box.width * t, baseY + Math.sin(t * Math.PI * text.length * 0.9) * 2.4],
        (t) => {
          note.style.clipPath = t < 1 ? `inset(-20% ${((1 - t) * 100).toFixed(1)}% -20% 0)` : "";
        },
      );
    };
    const falls =
      data.trail === "fall" ? attempts.map((points) => points[points.length - 1][0]) : [];
    falls.forEach((x, k) =>
      ink(crossPath(x), playAt + ((k + 1) / falls.length) * playFor - 120, 260),
    );
    for (const mark of data.marks) {
      const want = playAt + mark.at * playFor;
      if (mark.ring) ink(roughRing(...mark.ring, data.number * 5 + 3), want);
      if (mark.tick) ink(tickPath(mark.tick), want, 300);
      write(mark.note[0], mark.note[1], mark.note[2], want);
    }

    // The judge: the build to beat and this one, unnamed, in both orders,
    // and only then their names.
    const judge = data.judge;
    const [thumbA, thumbB] = thumbs;
    const [captionA, captionB] = thumbs.map((thumb) => thumb.querySelector("figcaption"));
    paintThumb(thumbA, judge.before);
    paintThumb(thumbB, data.scene);
    verdict.textContent = judge.verdict;
    const judgeAt = playAt + playFor + 250;
    orders.forEach((order, i) => {
      const letter = order.querySelector("b");
      timeline.add(judgeAt + i * 840, 300, (t) => {
        order.toggleAttribute("data-on", t > 0);
        letter.textContent = t >= 1 ? judge.winner : "";
      });
    });
    const shift = (e) => {
      thumbA.style.transform = e
        ? `translateX(calc(${(e * 100).toFixed(1)}% + ${(e * 12).toFixed(1)}px))`
        : "";
      thumbB.style.transform = e
        ? `translateX(calc(${(-e * 100).toFixed(1)}% - ${(e * 12).toFixed(1)}px))`
        : "";
    };
    timeline.add(judgeAt + 420, 1180, (t) => {
      const ms = t * 1180;
      if (ms < 380) shift(easeInOut(ms / 380));
      else if (ms < 840) shift(1);
      else shift(1 - easeInOut(clamp((ms - 840) / 340)));
    });
    timeline.add(judgeAt + 1640, 1, (t) => {
      const shown = t >= 1;
      captionA.textContent = shown ? `A, ${judge.beforeName}` : "A";
      captionB.textContent = shown ? `B, build ${data.number}` : "B";
      thumbA.classList.toggle("is-winner", shown && judge.winner === "A");
      thumbB.classList.toggle("is-winner", shown && judge.winner === "B");
      thumbA.classList.toggle("is-loser", shown && judge.winner === "B");
      thumbB.classList.toggle("is-loser", shown && judge.winner === "A");
    });
    const stampAt = Math.max(judgeAt + 1900, penFree + 120);
    timeline.add(stampAt - 260, 300, (t) => {
      verdict.style.opacity = String(t);
    });

    // The seal comes down, leaves its mark, and lifts away.
    const stampBox = stamp.getBoundingClientRect();
    const sealX = stampBox.left - deskBox.left + stampBox.width / 2;
    const sealY = stampBox.top - deskBox.top + stampBox.height / 2;
    timeline.add(stampAt, 760, (t) => {
      const down = t < 0.34 ? easeOut(t / 0.34) : t < 0.52 ? 1 : 1 - easeInOut((t - 0.52) / 0.48);
      press.style.opacity = t > 0 && t < 1 ? String(Math.min(1, down * 1.6)) : "0";
      press.setAttribute(
        "transform",
        `translate(${sealX.toFixed(1)} ${(sealY - 46 * (1 - down)).toFixed(1)})`,
      );
      const pressed = clamp((t - 0.34) / 0.16);
      stamp.style.opacity = String(pressed);
      stamp.style.transform = `rotate(${data.stamp[3]}deg) scale(${(1.06 - 0.06 * pressed).toFixed(3)})`;
      items[next].toggleAttribute("data-judged", t >= 1);
    });

    timeline.add(
      Math.max(penFree, stampAt),
      420,
      (t) => {
        const e = easeInOut(t);
        placePen(
          [penAt[0] + (rest[0] - penAt[0]) * e, penAt[1] + (rest[1] - penAt[1]) * e],
          Math.sin(Math.PI * t) * 8,
          REST_TURN * e,
        );
        if (tucked) pen.style.opacity = String(1 - t);
      },
      true,
    );
  }

  function seek(time) {
    placePen(rest, 0, REST_TURN);
    pen.style.opacity = tucked ? "0" : "1";
    timeline.seek(time);
  }

  // Where the scroll is, in builds: 1.5 is halfway through the second.
  function along() {
    const span = travel();
    if (span <= 0) return 0;
    const moved = pin.getBoundingClientRect().top - root.getBoundingClientRect().top;
    return clamp(moved / span) * PROOFS.length;
  }

  function update() {
    if (!visible || !width) return;
    const position = along();
    const next = Math.min(PROOFS.length - 1, Math.floor(position));
    if (next !== step) setup(next);
    const played = reduceMotion ? 1 : clamp((position - next) / PROOF_PLAY);
    const time = Math.round(played * timeline.end);
    if (time === last) return;
    last = time;
    seek(time);
  }

  // Pinned, the desk sits centred under the bar, shrunk if the screen is too
  // short to hold it whole.
  const centre = () => {
    const bar = parseFloat(getComputedStyle(pin).getPropertyValue("--bar-space")) || 88;
    const room = window.innerHeight - bar - 12;
    const fit = Math.min(1, room / pin.offsetHeight);
    const top = Math.max(bar, (window.innerHeight + bar - pin.offsetHeight * fit) / 2);
    pin.style.setProperty("--pin-top", `${Math.round(top)}px`);
    const scale = fit.toFixed(3);
    if (pin.style.getPropertyValue("--fit") === scale) return;
    pin.style.setProperty("--fit", scale);
    // The pen and the stamp were placed against the old size.
    if (step >= 0) {
      step = -1;
      update();
    }
  };
  centre();
  new ResizeObserver(centre).observe(pin);
  resizers.push(centre);

  new IntersectionObserver(
    (entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      if (!visible) return;
      if (!width) layout();
      update();
    },
    { rootMargin: "120px 0px" },
  ).observe(desk);

  resizers.push(() => {
    if (!width) return;
    layout();
    const keep = step;
    step = -1;
    if (keep >= 0) update();
  });

  return { onScroll: update };
}

// Overnight: one night of a run. Scrolling moves the sky from moonlight to
// dawn, and the builds land along the bottom as the hours pass.
const NIGHT_MINUTES = 480;
const NIGHT_KEPT = new Set([2, 5, 8, 12, 15, 19, 23, 26, 30]);
const NIGHT_BUILDS = Array.from({ length: 31 }, (_, i) => ({
  minute: 6 + ((i + 0.25 + hash2(i, 41) * 0.5) / 31) * 470,
  kept: NIGHT_KEPT.has(i),
}));

function paintNight(c, W, H, t) {
  const grey = (v) => `rgb(${Math.round(v)}, ${Math.round(v)}, ${Math.round(v)})`;
  const sky = c.createLinearGradient(0, 0, W, 0);
  sky.addColorStop(0, grey(8 + 96 * t ** 1.7));
  sky.addColorStop(0.55, grey(16 + 170 * t ** 1.4));
  sky.addColorStop(1, grey(30 + 225 * t ** 1.1));
  c.fillStyle = sky;
  c.fillRect(0, 0, W, H);
  const top = c.createLinearGradient(0, 0, 0, H);
  top.addColorStop(0, `rgba(0, 0, 0, ${0.3 * (1 - t * 0.6)})`);
  top.addColorStop(0.7, "rgba(0, 0, 0, 0)");
  c.fillStyle = top;
  c.fillRect(0, 0, W, H);

  const stars = clamp(1 - t * 1.7);
  if (stars > 0) {
    c.fillStyle = `rgba(255, 255, 255, ${stars})`;
    for (let i = 0; i < 80; i += 1) {
      c.fillRect(Math.floor(hash2(i, 51) * W * 0.92), Math.floor(hash2(i, 52) * H * 0.62), 1, 1);
    }
  }
  c.fillStyle = `rgba(255, 255, 255, ${clamp(1.2 - t)})`;
  c.beginPath();
  c.arc(W * (0.14 + t * 0.12), H * (0.2 + t * 0.72), H * 0.085, 0, Math.PI * 2);
  c.fill();

  if (t > 0.5) {
    const rise = (t - 0.5) / 0.5;
    const sx = W * 0.87;
    const sy = H * (1.1 - rise * 0.44);
    const glow = c.createRadialGradient(sx, sy, H * 0.1, sx, sy, H * 0.5);
    glow.addColorStop(0, `rgba(255, 40, 20, ${0.55 * rise})`);
    glow.addColorStop(1, "rgba(255, 40, 20, 0)");
    c.fillStyle = glow;
    c.fillRect(0, 0, W, H);
    c.fillStyle = "rgb(255, 0, 0)";
    c.beginPath();
    c.arc(sx, sy, H * 0.13, 0, Math.PI * 2);
    c.fill();
  }

  const ridge = (x) =>
    H * (0.8 + 0.05 * Math.sin((x / W) * 9 + 1) + 0.025 * Math.sin((x / W) * 23));
  c.beginPath();
  c.moveTo(0, H);
  for (let x = 0; x <= W; x += 1) c.lineTo(x, ridge(x));
  c.lineTo(W, H);
  c.closePath();
  c.fillStyle = "#000";
  c.fill();
  const tx = W * 0.64;
  const base = ridge(tx);
  const tall = H * 0.2;
  c.beginPath();
  c.moveTo(tx - 4, base + 1);
  c.lineTo(tx - 2.5, base - tall);
  c.lineTo(tx + 2.5, base - tall);
  c.lineTo(tx + 4, base + 1);
  c.fill();
  c.beginPath();
  c.moveTo(tx - 4.5, base - tall);
  c.lineTo(tx, base - tall - H * 0.07);
  c.lineTo(tx + 4.5, base - tall);
  c.fill();
  if (t < 0.94) {
    c.fillStyle = "rgb(255, 0, 0)";
    c.fillRect(tx - 1.5, base - tall + H * 0.012, 3, H * 0.03);
  }
}

function startNight(root) {
  const sky = root.querySelector(".night-sky");
  const canvas = root.querySelector("[data-night-canvas]");
  const context = canvas.getContext("2d");
  const strip = root.querySelector("[data-night-strip]");
  const head = root.querySelector("[data-night-head]");
  const clock = root.querySelector("[data-night-clock]");
  const ticks = NIGHT_BUILDS.map((build) => {
    const tick = strip.appendChild(document.createElement("i"));
    if (build.kept) tick.className = "is-kept";
    tick.style.left = `${(build.minute / NIGHT_MINUTES) * 100}%`;
    return tick;
  });
  ["23:00", "01:00", "03:00", "05:00", "07:00"].forEach((label, i) => {
    const hour = strip.appendChild(document.createElement("span"));
    hour.textContent = label;
    hour.style.left = `${i * 25}%`;
  });
  let width = 0;
  let height = 0;
  let cell = 4;
  let last = -1;
  let visible = false;

  function layout() {
    const size = fitCanvas(canvas, context);
    width = size.width;
    height = size.height;
    cell = Math.max(3, Math.round(width / 300));
    last = -1;
  }

  function render(p) {
    const cols = Math.ceil(width / cell);
    const rows = Math.ceil(height / cell);
    context.clearRect(0, 0, width, height);
    drawField(
      context,
      sampleField(cols, rows, (c, w, h) => paintNight(c, w, h, p)),
      cell,
    );
    head.style.setProperty("--p", p.toFixed(4));
    head.classList.toggle("is-late", p > 0.86);
    const minute = p * NIGHT_MINUTES;
    const of = (23 * 60 + minute) % (24 * 60);
    clock.textContent = `${String(Math.floor(of / 60)).padStart(2, "0")}:${String(Math.floor(of % 60)).padStart(2, "0")}`;
    NIGHT_BUILDS.forEach((build, i) => ticks[i].toggleAttribute("data-on", build.minute <= minute));
  }

  function update() {
    if (!visible || !width) return;
    const rect = sky.getBoundingClientRect();
    const view = window.innerHeight;
    const middle = rect.top + rect.height / 2;
    const p = Math.round(clamp((view * 0.85 - middle) / (view * 0.63)) * 240) / 240;
    if (p === last) return;
    last = p;
    render(p);
  }

  new IntersectionObserver(
    (entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      if (!visible) return;
      if (!width) layout();
      update();
    },
    { rootMargin: "120px 0px" },
  ).observe(root);

  resizers.push(() => {
    if (!width) return;
    layout();
    update();
  });

  return { onScroll: update };
}

// The agent slider only moves while it is on screen.
const marquee = document.querySelector("[data-marquee]");
if (marquee) {
  new IntersectionObserver((entries) => {
    marquee.toggleAttribute("data-paused", !entries.some((entry) => entry.isIntersecting));
  }).observe(marquee);
}

const proofsRoot = document.querySelector("[data-proofs]");
const story = proofsRoot ? startProofs(proofsRoot) : null;

const nightRoot = document.querySelector("[data-night]");
const night = nightRoot ? startNight(nightRoot) : null;

// You direct: what was asked for, and the build before and after it, split by
// a handle you can drag. Each side carries its own playtest and the red pen's
// marks, and the handle comes to rest where the change shows best.
const ASKS = [
  {
    before: { scene: SCENES.first, round: "Round 2" },
    after: { scene: SCENES.snow, round: "Round 4" },
    rest: 0.36,
    marks: {
      before: [{ note: ["blends into the hills", 0.04, 0.24] }],
      after: [{ ring: [0.47, 0.445, 0.07, 0.045], note: ["reads now", 0.38, 0.3] }],
    },
    note: "Round 3 tried something else and lost the blind compare, so it was thrown away. Round 4 kept the snow. The tester: “The ridge reads clearly now.”",
  },
  {
    before: { scene: { ...SCENES.snow, lantern: false }, round: "Round 4", walk: "lantern" },
    after: { scene: SCENES.snow, round: "Round 5", walk: "lantern" },
    rest: 0.86,
    marks: {
      before: [{ note: ["nothing happens", 0.22, 0.24] }],
      after: [{ tick: [0.95, 0.4], note: ["lit", 0.9, 0.24] }],
    },
    note: "Kept on the first try, 14 minutes later. The tester: “Lighting it feels like an ending.”",
  },
  {
    before: { scene: SCENES.snow, round: "Round 5", walk: "fall" },
    after: { scene: SCENES.stars, round: "Round 7", walk: "across" },
    rest: 0.45,
    marks: {
      before: [{ cross: [0.39, 0.95], note: ["falls in, ×3", 0.05, 0.4] }],
      after: [
        { tick: [0.5, 0.68], note: ["clears it", 0.53, 0.63] },
        { tick: [0.92, 0.39], note: ["to the lantern", 0.97, 0.22, "end"] },
      ],
    },
    note: "Round 6 made the ledges hard to see and was thrown away. Round 7 added the double jump, and the tester crossed the whole level for the first time: “The long gap finally feels fair.”",
  },
];

// Where the tester is at u in [0, 1], in scene fractions, for each kind of run.
const WALKS = {
  lantern: (u) => {
    if (u < 0.85) return Object.values(testerAt(0.74 + (u / 0.85) * 0.26));
    return [0.79 + ((u - 0.85) / 0.15) * 0.035, PLATFORMS[2][2]];
  },
  fall: (u) => {
    if (u < 0.4) return [0.08 + (0.21 * u) / 0.4, PLATFORMS[0][2]];
    const s = (u - 0.4) / 0.6;
    return [0.29 + 0.1 * s, 0.8 - 0.5 * s + 0.72 * s * s];
  },
  // The double jump over the long gap, then the rest of the level.
  across: (u) => {
    if (u < 0.12) return [0.08 + (0.21 * u) / 0.12, PLATFORMS[0][2]];
    if (u < 0.22) {
      const s = (u - 0.12) / 0.1;
      return [0.29 + 0.06 * s, 0.8 - 0.44 * s + 0.3 * s * s];
    }
    if (u < 0.34) {
      const s = (u - 0.22) / 0.12;
      return [0.35 + 0.12 * s, 0.66 - 0.26 * s + 0.33 * s * s];
    }
    if (u < 0.88) return Object.values(testerAt(0.57 + ((u - 0.34) / 0.54) * 0.43));
    return [0.79 + ((u - 0.88) / 0.12) * 0.035, PLATFORMS[2][2]];
  },
};

function startDirect(root) {
  const tabs = [...root.querySelectorAll("[data-ask]")];
  const view = root.querySelector("[data-compare]");
  const canvas = root.querySelector("[data-compare-canvas]");
  const context = canvas.getContext("2d");
  const handle = root.querySelector("[data-handle]");
  const before = root.querySelector("[data-before]");
  const after = root.querySelector("[data-after]");
  const note = root.querySelector("[data-compare-note]");
  const layers = Object.fromEntries(
    ["before", "after"].map((side) => {
      const layer = root.querySelector(`[data-overlay="${side}"]`);
      return [side, { svg: layer.querySelector("svg"), scrawls: layer.querySelector("div") }];
    }),
  );
  const timeline = createTimeline();
  const cache = new Map();
  let width = 0;
  let height = 0;
  let cell = 4;
  let current = 0;
  let split = 0.5;
  let sweep = 0;
  let frame = 0;
  let dragging = false;

  function fieldFor(scene) {
    const key = JSON.stringify(scene);
    let field = cache.get(key);
    if (!field) {
      field = sampleField(Math.ceil(width / cell), Math.ceil(height / cell), (c, w, h) =>
        paintValley(c, w, h, scene),
      );
      cache.set(key, field);
    }
    return field;
  }

  function layout() {
    const size = fitCanvas(canvas, context);
    width = size.width;
    height = size.height;
    cell = Math.max(3, Math.round(Math.min(width, height * 1.33) / 150));
    for (const layer of Object.values(layers)) {
      layer.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    }
    cache.clear();
  }

  function draw() {
    if (!width) return;
    const ask = ASKS[current];
    const x = Math.round((split * width) / cell) * cell;
    context.clearRect(0, 0, width, height);
    drawField(context, fieldFor(ask.before.scene), cell, { x1: x });
    drawField(context, fieldFor(ask.after.scene), cell, { x0: x });
    view.style.setProperty("--split", String(x / width));
    handle.setAttribute("aria-valuenow", String(Math.round(split * 100)));
  }

  function setSplit(value) {
    split = clamp(value, 0.02, 0.98);
    draw();
  }

  // Plans each side's playtest and marks on the timeline.
  function plan(ask) {
    timeline.clear();
    const at = ([x, y]) => [x * width, y * height];
    for (const side of ["before", "after"]) {
      const { svg, scrawls } = layers[side];
      svg.replaceChildren();
      scrawls.replaceChildren();
      const run = ask[side];
      let clock = side === "after" ? 250 : 0;
      if (run.walk) {
        const walk = WALKS[run.walk];
        const trail = svgNode(svg, "g", { class: "trail" });
        const dots = [];
        let previous = null;
        for (let i = 0; i <= 240; i += 1) {
          const u = i / 240;
          const [px, py] = at(walk(u));
          const column = Math.round(px / cell);
          if (column === previous || column % 2 || py > height) continue;
          previous = column;
          dots.push({
            u,
            dot: svgNode(trail, "rect", {
              x: column * cell,
              y: (Math.round(py / cell) - 2) * cell,
              width: cell * 0.8,
              height: cell * 0.8,
            }),
          });
        }
        const fox = svgNode(svg, "g", { class: "fox" });
        svgNode(fox, "rect", {
          class: "fox-back",
          x: -cell,
          y: -cell,
          width: 12 * cell,
          height: 7 * cell,
        });
        drawSprite(
          (x, y) =>
            svgNode(fox, "rect", {
              x: x * cell,
              y: y * cell,
              width: cell * 0.85,
              height: cell * 0.85,
            }),
          5,
          6,
        );
        const runFor = run.walk === "across" ? 2200 : 1300;
        timeline.add(clock, runFor, (t) => {
          const u = run.walk === "fall" ? t : easeInOut(t);
          for (const { dot, u: when } of dots) dot.setAttribute("opacity", when <= u ? "1" : "0");
          const [px, py] = at(walk(u));
          fox.setAttribute("opacity", py > height + cell * 2 ? "0" : "1");
          fox.setAttribute(
            "transform",
            `translate(${(Math.round(px / cell) - 5) * cell} ${(Math.round(py / cell) - 6) * cell})`,
          );
        });
        clock += runFor;
      }
      clock += 150;
      for (const mark of ask.marks[side]) {
        let d = "";
        if (mark.ring) {
          const [cx, cy, rx, ry] = mark.ring;
          const [px, py] = at([cx, cy]);
          d = roughRing(px, py, rx * width, ry * height, current * 3 + side.length);
        } else if (mark.tick) {
          const [px, py] = at(mark.tick);
          d = `M${px - 9} ${py - 1}L${px - 2} ${py + 7}L${px + 13} ${py - 11}`;
        } else if (mark.cross) {
          const [px, py] = at(mark.cross);
          d = `M${px - 10} ${py - 10}L${px + 10} ${py + 10}M${px + 10} ${py - 11}L${px - 10} ${py + 9}`;
        }
        if (d) {
          const path = svgNode(svg, "path", { class: "mark", d });
          const length = path.getTotalLength();
          path.style.strokeDasharray = String(length);
          timeline.add(clock, 440, (t) => {
            path.style.strokeDashoffset = String(length * (1 - t));
          });
          clock += 360;
        }
        if (mark.note) {
          // A note anchored at its end reads leftward from the picture's edge.
          const [text, nx, ny, anchor] = mark.note;
          const scrawl = scrawls.appendChild(document.createElement("span"));
          scrawl.className = "scrawl";
          scrawl.textContent = text;
          if (anchor === "end") scrawl.style.right = `${(1 - nx) * 100}%`;
          else scrawl.style.left = `${nx * 100}%`;
          scrawl.style.top = `${ny * 100}%`;
          const writeFor = 120 + text.length * 22;
          timeline.add(clock, writeFor, (t) => {
            scrawl.style.clipPath =
              t < 1 ? `inset(-30% ${((1 - t) * 100).toFixed(1)}% -30% 0)` : "";
          });
          clock += writeFor;
        }
      }
    }
  }

  function play(instant) {
    cancelAnimationFrame(frame);
    if (instant) {
      timeline.seek(timeline.end);
      return;
    }
    const begin = performance.now();
    const end = timeline.end;
    const tick = (now) => {
      const time = now - begin;
      timeline.seek(Math.min(time, end));
      if (time < end) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  }

  function select(index, animate) {
    current = index;
    tabs.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
    });
    const ask = ASKS[index];
    before.textContent = `Before, ${ask.before.round.toLowerCase()}`;
    after.textContent = `After, ${ask.after.round.toLowerCase()}`;
    note.textContent = ask.note;
    note.removeAttribute("data-swap");
    void note.offsetWidth;
    note.setAttribute("data-swap", "");
    cancelAnimationFrame(sweep);
    if (!width) return;
    plan(ask);
    if (!animate || reduceMotion) {
      setSplit(ask.rest);
      play(true);
      return;
    }
    play(false);
    // Wipe the new build in from the right, then rest where the change shows.
    const start = performance.now();
    const from = 0.98;
    const step = (now) => {
      const t = clamp((now - start) / 800);
      setSplit(from + (ask.rest - from) * easeOut(t));
      if (t < 1) sweep = requestAnimationFrame(step);
    };
    sweep = requestAnimationFrame(step);
  }

  const fromPointer = (event) => {
    const rect = view.getBoundingClientRect();
    return (event.clientX - rect.left) / rect.width;
  };
  view.addEventListener("pointerdown", (event) => {
    dragging = true;
    cancelAnimationFrame(sweep);
    try {
      view.setPointerCapture(event.pointerId);
    } catch {
      // A pointer can end before capture lands; dragging still works without it.
    }
    setSplit(fromPointer(event));
  });
  view.addEventListener("pointermove", (event) => {
    if (dragging) setSplit(fromPointer(event));
  });
  const release = () => (dragging = false);
  view.addEventListener("pointerup", release);
  view.addEventListener("pointercancel", release);
  handle.addEventListener("keydown", (event) => {
    const step = { ArrowLeft: -0.05, ArrowRight: 0.05, Home: -1, End: 1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    setSplit(Math.abs(step) === 1 ? (step < 0 ? 0 : 1) : split + step);
  });

  // On a narrow screen the picture sits above the requests; bring it back
  // into view when a request is picked below it.
  const reveal = () => {
    const box = view.getBoundingClientRect();
    if (box.top >= 70 && box.bottom <= window.innerHeight) return;
    window.scrollTo({
      top: window.scrollY + box.top - 90,
      behavior: reduceMotion ? "auto" : "smooth",
    });
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => {
      select(index, true);
      if (window.matchMedia("(max-width: 900px)").matches) reveal();
    });
    tab.addEventListener("keydown", (event) => {
      const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      const next = (index + step + tabs.length) % tabs.length;
      tabs[next].focus();
      select(next, true);
    });
  });

  select(0, false);
  whenVisible(
    root,
    () => {
      layout();
      select(current, false);
    },
    "200px 0px",
  );
  // The first pair plays once most of the picture is on screen.
  new IntersectionObserver(
    (entries, observer) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      if (!width) layout();
      select(current, true);
    },
    { threshold: 0.5 },
  ).observe(view);
  resizers.push(() => {
    if (!width) return;
    layout();
    select(current, false);
  });
}

const directRoot = document.querySelector("[data-direct]");
if (directRoot) startDirect(directRoot);

// Bar: the section you are reading, and how far down the page you are,
// shown on the sheet's two edges.
function startBar() {
  const bar = document.querySelector("[data-bar]");
  const links = [...document.querySelectorAll("[data-nav-link]")];
  const mark = document.querySelector("[data-nav-mark]");
  const edge = document.querySelector("[data-edge-progress]");
  const targets = links.map((link) => document.getElementById(link.dataset.navLink));
  const end = document.getElementById("join");
  let current = -2;

  function update() {
    bar?.toggleAttribute("data-scrolled", window.scrollY > 4);
    if (edge) {
      const room = document.documentElement.scrollHeight - window.innerHeight;
      edge.style.setProperty("--p", String(room > 0 ? clamp(window.scrollY / room) : 0));
    }
    if (!mark) return;
    const line = window.innerHeight * 0.42;
    let active = -1;
    targets.forEach((target, index) => {
      if (target && target.getBoundingClientRect().top <= line) active = index;
    });
    if (end && end.getBoundingClientRect().top <= line) active = -1;
    if (active === current) return;
    current = active;
    links.forEach((link, index) => {
      if (index === active) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    });
    if (active < 0) {
      mark.style.opacity = "0";
      return;
    }
    const link = links[active];
    mark.style.opacity = "1";
    mark.style.width = `${link.offsetWidth}px`;
    mark.style.transform = `translateX(${link.offsetLeft}px)`;
  }

  resizers.push(() => {
    current = -2;
    update();
  });
  update();
  return { onScroll: update };
}

const barState = startBar();

let scrollFrame = 0;
window.addEventListener(
  "scroll",
  () => {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      barState.onScroll();
      story?.onScroll();
      night?.onScroll();
      margins?.onScroll();
    });
  },
  { passive: true },
);

const MESSAGES = {
  ok: "You're on the list. We'll email you when your invite is ready.",
  email: "That email doesn't look right. Check it and try again.",
  "slow-down": "Too many tries from here. Give it a few minutes.",
  closed: "The waitlist is resting for a moment. Please try again soon.",
  network: "Couldn't reach the server. Check your connection and try again.",
  unknown: "Something went wrong on our side. Please try again.",
};

const looksLikeEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
const pageOpenedAt = performance.now();

for (const form of document.querySelectorAll("[data-waitlist]")) {
  const status = form.querySelector("[data-status]");
  const button = form.querySelector("button[type=submit]");
  const label = button.querySelector("[data-label]");
  const idleLabel = label.textContent;
  const defaultNote = status.innerHTML;

  const show = (tone, key) => {
    delete status.dataset.tone;
    void status.offsetWidth;
    status.dataset.tone = tone;
    status.textContent = MESSAGES[key] ?? MESSAGES.unknown;
  };

  form.addEventListener("input", () => {
    if (status.dataset.tone === "error") {
      delete status.dataset.tone;
      status.innerHTML = defaultNote;
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (button.hasAttribute("data-done")) return;
    const data = new FormData(form);
    const email = String(data.get("email") ?? "").trim();
    if (!looksLikeEmail(email)) {
      show("error", "email");
      form.querySelector("input[name=email]").focus();
      return;
    }
    button.disabled = true;
    label.textContent = "Joining…";
    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          name: data.get("name") ?? undefined,
          role: data.get("role") ?? undefined,
          website: data.get("website") ?? "",
          source: form.dataset.source,
          elapsed: Math.round(performance.now() - pageOpenedAt),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.ok) {
        show("ok", "ok");
        label.textContent = "You're on the list";
        button.setAttribute("data-done", "");
        button.disabled = false;
        form.querySelector("input[name=email]").value = "";
        return;
      }
      show("error", body.error ?? "unknown");
    } catch {
      show("error", "network");
    }
    button.disabled = false;
    label.textContent = idleLabel;
  });
}

// Ink: seal stamps on the sections, strokes painted as headings arrive, and
// the sheet that glides between requests.
(() => {
  const SEALS = { run: "試", studio: "指", overnight: "夜", faq: "問", join: "入" };
  for (const [id, glyph] of Object.entries(SEALS)) {
    const section = document.getElementById(id);
    if (!section) continue;
    const seal = document.createElement("span");
    seal.className = "kanji-seal";
    seal.setAttribute("aria-hidden", "true");
    seal.textContent = glyph;
    // The waitlist's heading shares its row with the fox, so its seal sits
    // at the end of the heading instead of the section's corner.
    if (id === "join") {
      seal.classList.add("is-inline");
      section.querySelector("h2").append(seal);
    } else section.prepend(seal);
  }

  // Motion: strokes painted and seals pressed as their heading comes into
  // view, and one sheet that glides between the requests. Nothing here runs for people who ask for less motion.
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (still) return;

  const below = (node) => node.getBoundingClientRect().top > window.innerHeight * 0.92;
  const reveal = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        reveal.unobserve(entry.target);
        const heading = entry.target;
        heading.dataset.ink = "in";
        const seal = heading.closest("section")?.querySelector(".kanji-seal");
        if (seal?.dataset.stamp === "wait") seal.dataset.stamp = "in";
      }
    },
    { rootMargin: "0px 0px -18% 0px" },
  );
  for (const heading of document.querySelectorAll(".section-head h2, .faq-section h2, .join h2")) {
    if (!below(heading)) continue;
    heading.dataset.ink = "wait";
    const seal = heading.closest("section")?.querySelector(".kanji-seal");
    if (seal) seal.dataset.stamp = "wait";
    reveal.observe(heading);
  }

  const asks = document.querySelector(".asks");
  if (asks) {
    const sheet = document.createElement("span");
    sheet.className = "ask-sheet";
    sheet.setAttribute("aria-hidden", "true");
    asks.prepend(sheet);
    asks.classList.add("has-sheet");
    const place = (animate) => {
      const chosen = asks.querySelector('[aria-selected="true"]');
      if (!chosen) return;
      if (!animate) sheet.style.transition = "none";
      sheet.style.transform = `translate(${chosen.offsetLeft}px, ${chosen.offsetTop}px)`;
      sheet.style.width = `${chosen.offsetWidth}px`;
      sheet.style.height = `${chosen.offsetHeight}px`;
      if (!animate) {
        void sheet.offsetWidth;
        sheet.style.transition = "";
      }
    };
    place(false);
    new MutationObserver(() => place(true)).observe(asks, {
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-selected"],
    });
    new ResizeObserver(() => place(false)).observe(asks);
  }
})();
