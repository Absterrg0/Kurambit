// The /waitlist page: the ink fox as a few thousand pixels on springs. They
// gather when the page opens, part around the cursor, ripple up from the field
// as you type, and burst and settle when you join. The canvas paints only while
// a pixel is moving; at rest the page is a still picture.

const PAPER = "#f2efe8";
const SHU = "#e2582a";
const PAPER_MOVING = "rgba(242, 239, 232, 0.42)";
const SHU_MOVING = "rgba(226, 88, 42, 0.5)";
const DUST = "rgba(242, 239, 232, 0.17)";
const STEP = 1000 / 60;
const SPRING = 0.055;
const DAMPING = 0.84;
const INTRO_MS = 1500;
const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// 8x8 Bayer matrix, normalised to thresholds in (0, 1).
const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28,
  52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7,
  39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
].map((value) => (value + 0.5) / 64);
const bayer = (x, y) => BAYER[(y & 7) * 8 + (x & 7)];
const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

const canvas = document.getElementById("fox");
const context = canvas.getContext("2d");
const image = new Image();
image.decoding = "async";

const KIND_PAPER = 0;
const KIND_SHU = 1;
const KIND_DUST = 2;

let width = 0;
let height = 0;
let cell = 0;
let size = 0;
let count = 0;
let homeX = new Float32Array(0);
let homeY = homeX;
let posX = homeX;
let posY = homeX;
let velX = homeX;
let velY = homeX;
let delay = homeX;
let kind = new Uint8Array(0);
let centreX = 0;
let centreY = 0;
let boxBottom = 0;
let ready = false;

// Simulated time advances only while the loop runs, so effects started
// before an idle stretch do not jump when it ends.
let time = 0;
let frame = 0;
let last = 0;
let carry = 0;
const pointer = { x: 0, y: 0, tx: 0, ty: 0, s: 0, ts: 0 };
const ripples = [];
let shakeAt = -Infinity;

function sample(cols, rows) {
  const scratch = document.createElement("canvas");
  scratch.width = cols;
  scratch.height = rows;
  const scratchContext = scratch.getContext("2d", { willReadFrequently: true });
  scratchContext.drawImage(image, 0, 0, cols, rows);
  const data = scratchContext.getImageData(0, 0, cols, rows).data;
  const density = new Float32Array(cols * rows);
  const accent = new Uint8Array(cols * rows);
  for (let i = 0; i < cols * rows; i += 1) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const a = data[i * 4 + 3] / 255;
    const lightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    let value = a * (1 - lightness * 0.55);
    const chroma = (r - Math.max(g, b)) / 255;
    if (a > 0.25 && chroma > 0.17) {
      accent[i] = 1;
      value = Math.max(value, a * chroma);
    } else if (a > 0.25 && chroma > 0.04) {
      accent[i] = 1;
      value = a * chroma;
    }
    density[i] = smoothstep(0.18, 0.72, value);
  }
  // Keep the brush stroke and drop pixels that would stand alone.
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
      if (neighbours === 0) inked[y * cols + x] = 0;
    }
  }
  return { inked, accent };
}

function build(intro) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  width = rect.width;
  height = rect.height;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);

  // The fox fits the box around the canvas, which bleeds past it.
  const box = canvas.parentElement.getBoundingClientRect();
  const boxLeft = box.left - rect.left;
  const boxTop = box.top - rect.top;
  boxBottom = boxTop + box.height;
  const ground = 5;
  const ratio = image.naturalWidth / image.naturalHeight;
  cell = Math.max(3, Math.round(box.height / 132));
  size = cell >= 4 ? cell - 1 : cell;
  const foxHeight = Math.min(box.height - (ground + 1) * cell, (box.width - 16) / ratio);
  const rows = Math.floor(foxHeight / cell);
  const cols = Math.floor(rows * ratio);
  const offsetX = Math.round(boxLeft + (box.width - cols * cell) / 2);
  const offsetY = Math.floor(boxBottom - (rows + ground + 1) * cell);
  centreX = offsetX + (cols * cell) / 2;
  centreY = offsetY + rows * cell * 0.55;

  const { inked, accent } = sample(cols, rows);
  const xs = [];
  const ys = [];
  const kinds = [];
  const delays = [];
  let lowest = 0;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const index = y * cols + x;
      if (!inked[index]) continue;
      lowest = Math.max(lowest, y);
      xs.push(offsetX + x * cell);
      ys.push(offsetY + y * cell);
      kinds.push(accent[index] ? KIND_SHU : KIND_PAPER);
      // The fox gathers from the ground up, the tail last.
      const order = (1 - y / rows) * 0.55 + bayer(x, y) * 0.3 + Math.random() * 0.15;
      delays.push((order + (accent[index] ? 0.12 : 0)) * INTRO_MS);
    }
  }
  // The shadow the fox sits on: an ellipse of dithered dust on the same
  // grid, tucked under the paws, densest there and gone by its rim.
  const pawLine = offsetY + (lowest - 4) * cell;
  let pawLeft = Infinity;
  let pawRight = -Infinity;
  for (let i = 0; i < xs.length; i += 1) {
    if (ys[i] < pawLine) continue;
    pawLeft = Math.min(pawLeft, xs[i]);
    pawRight = Math.max(pawRight, xs[i]);
  }
  const shadowX = (pawLeft + pawRight + cell) / 2;
  const reachX = (pawRight - pawLeft) * 0.62 + cell * 3;
  const top = offsetY + (lowest + 1) * cell;
  const reachColumns = Math.ceil(reachX / cell);
  for (let row = 0; row < ground; row += 1) {
    const ny = (row + 0.5) / ground;
    for (let column = -reachColumns; column <= reachColumns; column += 1) {
      const px = offsetX + Math.round((shadowX - offsetX) / cell + column) * cell;
      const nx = (px + cell / 2 - shadowX) / reachX;
      const value = smoothstep(0, 0.55, 1 - nx * nx - ny * ny);
      if (value > bayer(column + 64, row)) {
        xs.push(px);
        ys.push(top + row * cell);
        kinds.push(KIND_DUST);
        delays.push((0.05 + Math.random() * 0.2) * INTRO_MS);
      }
    }
  }

  count = xs.length;
  homeX = Float32Array.from(xs);
  homeY = Float32Array.from(ys);
  posX = Float32Array.from(xs);
  posY = Float32Array.from(ys);
  velX = new Float32Array(count);
  velY = new Float32Array(count);
  kind = Uint8Array.from(kinds);
  delay = new Float32Array(count);
  if (intro) {
    // Start as a loose swirl of ink around the fox that winds inward.
    const spread = Math.max(width, height);
    for (let i = 0; i < count; i += 1) {
      const dx = homeX[i] - centreX;
      const dy = homeY[i] - centreY;
      const angle = Math.atan2(dy, dx) + 0.9 + Math.random() * 0.5;
      const distance = Math.hypot(dx, dy) + spread * (0.12 + Math.random() * 0.42);
      posX[i] = centreX + Math.cos(angle) * distance;
      posY[i] = centreY + Math.sin(angle) * distance;
      delay[i] = time + delays[i];
    }
  }
  return true;
}

function step() {
  time += STEP;
  pointer.x += (pointer.tx - pointer.x) * 0.35;
  pointer.y += (pointer.ty - pointer.y) * 0.35;
  pointer.s += (pointer.ts - pointer.s) * 0.12;
  if (Math.abs(pointer.ts - pointer.s) < 0.003) pointer.s = pointer.ts;
  for (let r = ripples.length - 1; r >= 0; r -= 1) {
    if (time - ripples[r].start > ripples[r].life) ripples.splice(r, 1);
  }
  const shakeAge = time - shakeAt;
  const shake = shakeAge < 460 ? Math.sin(shakeAge / 24) * cell * 1.5 * (1 - shakeAge / 460) : 0;

  const radius = cell * 15;
  const radius2 = radius * radius;
  const push = cell * 2.6 * pointer.s;
  let moving = pointer.s !== pointer.ts || ripples.length > 0 || shake !== 0;
  for (let i = 0; i < count; i += 1) {
    if (time < delay[i]) {
      moving = true;
      continue;
    }
    const hx = homeX[i];
    const hy = homeY[i];
    let tx = hx + shake;
    let ty = hy;
    if (push > 0.01) {
      const dx = hx - pointer.x;
      const dy = hy - pointer.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < radius2) {
        const distance = Math.sqrt(d2) || 1;
        const falloff = 1 - d2 / radius2;
        const shift = falloff * falloff * push;
        tx += (dx / distance) * shift;
        ty += (dy / distance) * shift;
      }
    }
    for (const ripple of ripples) {
      const dx = hx - ripple.x;
      const dy = hy - ripple.y;
      const distance = Math.sqrt(dx * dx + dy * dy) || 1;
      const age = time - ripple.start;
      const band = (distance - age * ripple.speed) / ripple.width;
      if (band > 3 || band < -3) continue;
      const fade = (1 - age / ripple.life) ** 2;
      const shift = ripple.amp * Math.exp(-band * band) * fade;
      tx += (dx / distance) * shift;
      ty += (dy / distance) * shift;
    }
    velX[i] = (velX[i] + (tx - posX[i]) * SPRING) * DAMPING;
    velY[i] = (velY[i] + (ty - posY[i]) * SPRING) * DAMPING;
    posX[i] += velX[i];
    posY[i] += velY[i];
    if (
      !moving &&
      (Math.abs(velX[i]) > 0.02 ||
        Math.abs(velY[i]) > 0.02 ||
        Math.abs(tx - posX[i]) > 0.08 ||
        Math.abs(ty - posY[i]) > 0.08)
    ) {
      moving = true;
    }
  }
  return moving;
}

function draw(settled) {
  context.clearRect(0, 0, width, height);
  const paper = new Path2D();
  const shu = new Path2D();
  const paperMoving = new Path2D();
  const shuMoving = new Path2D();
  const dust = new Path2D();
  const far = cell * 2.2;
  for (let i = 0; i < count; i += 1) {
    const x = settled ? homeX[i] : Math.round(posX[i]);
    const y = settled ? homeY[i] : Math.round(posY[i]);
    if (kind[i] === KIND_DUST) {
      dust.rect(x, y, size, size);
      continue;
    }
    // Ink still in flight is fainter, so the fox brightens as it lands.
    const away =
      !settled &&
      (time < delay[i] || Math.abs(posX[i] - homeX[i]) + Math.abs(posY[i] - homeY[i]) > far);
    if (kind[i] === KIND_SHU) (away ? shuMoving : shu).rect(x, y, size, size);
    else (away ? paperMoving : paper).rect(x, y, size, size);
  }
  context.fillStyle = DUST;
  context.fill(dust);
  context.fillStyle = PAPER_MOVING;
  context.fill(paperMoving);
  context.fillStyle = SHU_MOVING;
  context.fill(shuMoving);
  context.fillStyle = PAPER;
  context.fill(paper);
  context.fillStyle = SHU;
  context.fill(shu);
}

function tick(now) {
  frame = 0;
  carry += last ? Math.min(now - last, 100) : STEP;
  last = now;
  // A frame can land before a whole step is due; that is not rest.
  let moving = true;
  while (carry >= STEP) {
    moving = step();
    carry -= STEP;
  }
  if (moving) {
    draw(false);
    frame = requestAnimationFrame(tick);
  } else {
    draw(true);
    last = 0;
    carry = 0;
  }
}

function wake() {
  if (ready && !still && !frame) frame = requestAnimationFrame(tick);
}

function ripple(x, y, amp, speed, life, rippleWidth) {
  if (still || !ready) return;
  if (ripples.length > 5) ripples.shift();
  ripples.push({ x, y, amp, speed, life, width: rippleWidth, start: time });
  wake();
}

function burst() {
  if (still || !ready) return;
  for (let i = 0; i < count; i += 1) {
    if (kind[i] === KIND_DUST) continue;
    const dx = homeX[i] - centreX;
    const dy = homeY[i] - centreY;
    const distance = Math.hypot(dx, dy) || 1;
    const force = (2 + Math.random() * 7) * (kind[i] === KIND_SHU ? 1.8 : 1);
    velX[i] += (dx / distance) * force;
    velY[i] += (dy / distance) * force - Math.random() * 2.5;
  }
  ripple(centreX, centreY, cell * 3, 0.9, 1100, 40);
}

function shake() {
  if (still || !ready) return;
  shakeAt = time;
  wake();
}

if (canvas) {
  if (!still) {
    // Follow the pointer anywhere on the page, so the fox answers before the
    // cursor reaches it.
    window.addEventListener("pointermove", (event) => {
      if (!ready || event.pointerType === "touch") return;
      const rect = canvas.getBoundingClientRect();
      pointer.tx = event.clientX - rect.left;
      pointer.ty = event.clientY - rect.top;
      if (pointer.s < 0.01) {
        pointer.x = pointer.tx;
        pointer.y = pointer.ty;
      }
      const margin = cell * 12;
      const inside =
        pointer.tx > -margin &&
        pointer.ty > -margin &&
        pointer.tx < width + margin &&
        pointer.ty < height + margin;
      pointer.ts = inside ? 1 : 0;
      wake();
    });
    document.documentElement.addEventListener("pointerleave", () => {
      pointer.ts = 0;
      wake();
    });
    canvas.parentElement.addEventListener("pointerdown", (event) => {
      const rect = canvas.getBoundingClientRect();
      ripple(event.clientX - rect.left, event.clientY - rect.top, cell * 2.2, 0.7, 900, 30);
    });
  }

  image.src = "/fox-ink.webp";
  image.decode().then(
    () => {
      if (!build(!still)) return;
      ready = true;
      if (still) draw(true);
      else wake();
    },
    () => {},
  );

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (ready && build(false)) draw(true);
    }, 150);
  });
}

// The form. The server answers the same way whether or not the address was
// already listed, so there is only one success.
const MESSAGES = {
  ok: "You're on the list. We'll email you when your invite is ready.",
  email: "That email doesn't look right. Check it and try again.",
  "slow-down": "Too many tries from here. Give it a few minutes.",
  closed: "The waitlist is resting for a moment. Please try again soon.",
  network: "Couldn't reach the server. Check your connection and try again.",
  unknown: "Something went wrong on our side. Please try again.",
};
const looksLikeEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
const openedAt = performance.now();

const form = document.querySelector("[data-waitlist]");
if (form) {
  const field = form.querySelector(".field");
  const input = form.querySelector("input[name=email]");
  const status = form.querySelector("[data-status]");
  const button = form.querySelector("button[type=submit]");
  const label = button.querySelector("[data-label]");
  const idleLabel = label.innerHTML;
  const defaultNote = status.innerHTML;
  let lastKey = 0;

  const show = (tone, key) => {
    status.dataset.tone = tone;
    status.textContent = MESSAGES[key] ?? MESSAGES.unknown;
  };
  const fail = (key) => {
    show("error", key);
    field.removeAttribute("data-shake");
    void field.offsetWidth;
    field.setAttribute("data-shake", "");
    shake();
  };

  input.addEventListener("input", () => {
    if (status.dataset.tone === "error") {
      delete status.dataset.tone;
      status.innerHTML = defaultNote;
    }
    // Each keystroke sends a soft wave up through the fox from the field.
    const now = performance.now();
    if (now - lastKey > 70) {
      lastKey = now;
      ripple(width / 2, boxBottom + cell * 10, cell * 1.4, 0.8, 900, cell * 7);
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (form.hasAttribute("data-done")) return;
    const data = new FormData(form);
    const email = String(data.get("email") ?? "").trim();
    if (!looksLikeEmail(email)) {
      fail("email");
      input.focus();
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
          website: data.get("website") ?? "",
          source: form.dataset.source,
          elapsed: Math.round(performance.now() - openedAt),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.ok) {
        show("ok", "ok");
        label.textContent = "You're on the list";
        form.setAttribute("data-done", "");
        button.disabled = false;
        input.value = "";
        input.blur();
        burst();
        return;
      }
      fail(body.error ?? "unknown");
    } catch {
      fail("network");
    }
    button.disabled = false;
    label.innerHTML = idleLabel;
  });
}
