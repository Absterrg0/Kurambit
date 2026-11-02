// Kurambit site: the dithered fox and the waitlist forms. No dependencies.

const INK = "#161513";
const VERMILION = "#e2582a";
const PAPER_DOT = "rgba(22, 21, 19, 0.08)";

for (const node of document.querySelectorAll("[data-year]")) {
  node.textContent = String(new Date().getFullYear());
}

/* ---------- Dithered fox ---------- */

// 8x8 Bayer matrix, normalised to thresholds in (0, 1).
const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28,
  52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7,
  39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
].map((value) => (value + 0.5) / 64);

function startFox(canvas) {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const image = new Image();
  image.decoding = "async";
  image.src = "fox-ink.webp";

  let cells = null; // Float32Array of ink density per cell
  let accent = null; // Uint8Array, 1 where the source is vermilion
  let cols = 0;
  let rows = 0;
  let cell = 0;
  let offsetX = 0;
  let offsetY = 0;
  let pointer = null;
  let reveal = reduceMotion ? 1 : 0;
  let frame = 0;

  const context = canvas.getContext("2d");

  function sample() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || !image.complete) return false;
    const ratio = image.naturalWidth / image.naturalHeight;
    // Chunky enough to read as pixels, fine enough to keep the fox's brushwork.
    cell = Math.max(4, Math.round(rect.width / 118));
    rows = Math.floor(rect.height / cell);
    cols = Math.floor(Math.min(rect.width / cell, rows * ratio));
    rows = Math.floor(cols / ratio);
    offsetX = Math.floor((rect.width - cols * cell) / 2);
    offsetY = Math.floor((rect.height - rows * cell) / 2);

    const scratch = document.createElement("canvas");
    scratch.width = cols;
    scratch.height = rows;
    const scratchContext = scratch.getContext("2d", { willReadFrequently: true });
    scratchContext.drawImage(image, 0, 0, cols, rows);
    const data = scratchContext.getImageData(0, 0, cols, rows).data;
    cells = new Float32Array(cols * rows);
    accent = new Uint8Array(cols * rows);
    for (let i = 0; i < cols * rows; i += 1) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      const a = data[i * 4 + 3] / 255;
      const lightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      cells[i] = a * (1 - lightness * 0.55);
      accent[i] = a > 0.25 && r > g + 45 && r > b + 60 ? 1 : 0;
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  function draw() {
    frame = 0;
    if (!cells) return;
    const width = canvas.width;
    const height = canvas.height;
    context.clearRect(0, 0, width, height);
    const size = cell - 1;
    const radius = cell * 9;
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const index = y * cols + x;
        const threshold = BAYER[(y % 8) * 8 + (x % 8)];
        // During the reveal, cells resolve top to bottom with a little noise.
        const gate =
          reveal >= 1 ? 1 : Math.min(1, Math.max(0, reveal * 1.6 - y / rows + threshold * 0.3));
        let value = cells[index] * gate;
        const px = offsetX + x * cell;
        const py = offsetY + y * cell;
        let near = 0;
        if (pointer) {
          const dx = px - pointer.x;
          const dy = py - pointer.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          near = distance < radius ? 1 - distance / radius : 0;
          value += near * 0.18;
        }
        if (value > threshold) {
          context.fillStyle = accent[index] || near > 0.55 ? VERMILION : INK;
          context.fillRect(px, py, size, size);
        } else if (near > 0) {
          context.fillStyle = PAPER_DOT;
          context.fillRect(px + size / 2 - 0.5, py + size / 2 - 0.5, 1.5, 1.5);
        }
      }
    }
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  function animateReveal() {
    const started = performance.now();
    const step = (now) => {
      reveal = Math.min(1, (now - started) / 1100);
      draw();
      if (reveal < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function boot() {
    if (!sample()) return;
    if (reveal < 1) animateReveal();
    else draw();
  }

  image.addEventListener("load", boot);
  if (image.complete) boot();

  canvas.addEventListener("pointermove", (event) => {
    const rect = canvas.getBoundingClientRect();
    pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    schedule();
  });
  canvas.addEventListener("pointerleave", () => {
    pointer = null;
    schedule();
  });

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (sample()) draw();
    }, 120);
  });
}

const foxCanvas = document.getElementById("fox");
if (foxCanvas) startFox(foxCanvas);

/* ---------- Waitlist ---------- */

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
