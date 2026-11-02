// Kurambit site: the dithered fox, clips that play only on screen, reveals and the waitlist.

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

for (const node of document.querySelectorAll("[data-year]")) {
  node.textContent = String(new Date().getFullYear());
}

/* ---------- Dithered fox ---------- */

const INK = "#f1e9d8";
const ACCENT = "#ff5a2a";

// 8x8 Bayer matrix, normalised to thresholds in (0, 1).
const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28,
  52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7,
  39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
].map((value) => (value + 0.5) / 64);

function dither(canvas) {
  const ink = canvas.dataset.ink ?? INK;
  const accentColor = canvas.dataset.accent ?? ACCENT;
  const cellsAcross = Number(canvas.dataset.cells ?? 70);
  const image = new Image();
  image.src = canvas.dataset.src;
  const context = canvas.getContext("2d");
  let state = null;
  let pointer = null;
  let reveal = reduceMotion ? 1 : 0;
  let frame = 0;

  function sample() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height || !image.naturalWidth) return false;
    const ratio = image.naturalWidth / image.naturalHeight;
    const cell = Math.max(2, Math.round(rect.width / cellsAcross));
    let rows = Math.floor(rect.height / cell);
    const cols = Math.floor(Math.min(rect.width / cell, rows * ratio));
    rows = Math.floor(cols / ratio);
    const scratch = document.createElement("canvas");
    scratch.width = cols;
    scratch.height = rows;
    const sc = scratch.getContext("2d", { willReadFrequently: true });
    sc.drawImage(image, 0, 0, cols, rows);
    const data = sc.getImageData(0, 0, cols, rows).data;
    const density = new Float32Array(cols * rows);
    const accent = new Uint8Array(cols * rows);
    for (let i = 0; i < cols * rows; i += 1) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      const a = data[i * 4 + 3] / 255;
      const light = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      density[i] = a * (1 - light * 0.55);
      accent[i] = a > 0.25 && r > g + 45 && r > b + 60 ? 1 : 0;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    state = {
      cols,
      rows,
      cell,
      density,
      accent,
      ox: Math.floor((rect.width - cols * cell) / 2),
      oy: Math.floor((rect.height - rows * cell) / 2),
    };
    return true;
  }

  function draw() {
    frame = 0;
    if (!state) return;
    const { cols, rows, cell, density, accent, ox, oy } = state;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const size = Math.max(1, cell - 1);
    const radius = cell * 10;
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const i = y * cols + x;
        const t = BAYER[(y % 8) * 8 + (x % 8)];
        // During the reveal, cells resolve top to bottom with a little noise.
        const gate = reveal >= 1 ? 1 : Math.min(1, Math.max(0, reveal * 1.6 - y / rows + t * 0.3));
        let v = density[i] * gate;
        const px = ox + x * cell;
        const py = oy + y * cell;
        let near = 0;
        if (pointer) {
          const d = Math.hypot(px - pointer.x, py - pointer.y);
          near = d < radius ? 1 - d / radius : 0;
          v += near * 0.2;
        }
        if (v > t) {
          context.fillStyle = accent[i] || near > 0.55 ? accentColor : ink;
          context.fillRect(px, py, size, size);
        }
      }
    }
  }

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };

  function boot() {
    if (!sample()) return;
    if (reveal >= 1) return draw();
    const started = performance.now();
    const step = (now) => {
      reveal = Math.min(1, (now - started) / 1100);
      draw();
      if (reveal < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
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
  let timer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(() => sample() && draw(), 150);
  });
}

for (const canvas of document.querySelectorAll("canvas.fox, canvas[data-dither]")) dither(canvas);

/* ---------- Clips play only while visible; sections ease in ---------- */

const videos = document.querySelectorAll("video[data-autoplay]");
const reveals = document.querySelectorAll("[data-reveal]");

if ("IntersectionObserver" in window) {
  if (!reduceMotion) {
    const videoObserver = new IntersectionObserver(
      (entries) => {
        for (const { target, isIntersecting } of entries) {
          if (isIntersecting) target.play().catch(() => {});
          else target.pause();
        }
      },
      { threshold: 0.25 },
    );
    for (const video of videos) videoObserver.observe(video);
  }

  const revealObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("in");
        revealObserver.unobserve(entry.target);
      }
    },
    { threshold: 0.08 },
  );
  for (const node of reveals) revealObserver.observe(node);
} else {
  for (const node of reveals) node.classList.add("in");
}

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
  const defaultNote = status.textContent;

  const show = (tone, key) => {
    status.dataset.tone = tone;
    status.textContent = MESSAGES[key] ?? MESSAGES.unknown;
  };

  form.addEventListener("input", () => {
    if (status.dataset.tone === "error") {
      delete status.dataset.tone;
      status.textContent = defaultNote;
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
