// Shared behaviour for the concept pages: waitlist, dithered art, clip rotation, reveals.

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

for (const node of document.querySelectorAll("[data-year]")) {
  node.textContent = String(new Date().getFullYear());
}

/* ---------- Ordered dither of any transparent image onto a canvas ---------- */

const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28,
  52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7,
  39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
].map((value) => (value + 0.5) / 64);

function dither(canvas) {
  const ink = canvas.dataset.ink ?? "#161513";
  const accentColor = canvas.dataset.accent ?? "#e2582a";
  const cellsAcross = Number(canvas.dataset.cells ?? 110);
  const shape = canvas.dataset.shape ?? "square";
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
    const cell = Math.max(3, Math.round(rect.width / cellsAcross));
    let rows = Math.floor(rect.height / cell);
    let cols = Math.floor(Math.min(rect.width / cell, rows * ratio));
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
      density[i] =
        canvas.dataset.mode === "light" ? a * (0.35 + light * 0.65) : a * (1 - light * 0.55);
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
          if (shape === "dot") {
            context.beginPath();
            context.arc(px + size / 2, py + size / 2, size / 2, 0, Math.PI * 2);
            context.fill();
          } else {
            context.fillRect(px, py, size, size);
          }
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

for (const canvas of document.querySelectorAll("canvas[data-dither]")) dither(canvas);

/* ---------- Video rotation: one <video> cycling through real game clips ---------- */

for (const video of document.querySelectorAll("video[data-cycle]")) {
  const clips = video.dataset.cycle.split(",");
  const label = document.querySelector(video.dataset.label ?? "");
  const names = (video.dataset.names ?? "").split(",");
  let index = 0;
  const show = (i) => {
    index = (i + clips.length) % clips.length;
    video.src = `${video.dataset.base}${clips[index]}.webm`;
    video.poster = `${video.dataset.base}${clips[index]}.jpg`;
    if (label) label.textContent = names[index] ?? clips[index];
    if (!reduceMotion) video.play().catch(() => {});
  };
  video.addEventListener("ended", () => show(index + 1));
  for (const button of document.querySelectorAll(`[data-cycle-target="${video.id}"]`)) {
    button.addEventListener("click", () => show(index + Number(button.dataset.step ?? 1)));
  }
  show(0);
}

/* ---------- Hover-to-play clips and reveals ---------- */

for (const video of document.querySelectorAll("video[data-hover]")) {
  const host = video.closest("[data-hover-host]") ?? video;
  host.addEventListener("pointerenter", () => video.play().catch(() => {}));
  host.addEventListener("pointerleave", () => video.pause());
}

if (!reduceMotion && "IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.18 },
  );
  for (const node of document.querySelectorAll("[data-reveal]")) observer.observe(node);
} else {
  for (const node of document.querySelectorAll("[data-reveal]")) node.classList.add("in");
}

/* ---------- Waitlist ---------- */

const MESSAGES = {
  ok: "You're on the list. We'll email you when your invite is ready.",
  email: "That email doesn't look right.",
  "slow-down": "Too many tries. Give it a few minutes.",
  closed: "Preview build: signups open on kurambit.com.",
  network: "Couldn't reach the server. Try again.",
  unknown: "Something went wrong. Please try again.",
};
const openedAt = performance.now();

for (const form of document.querySelectorAll("[data-waitlist]")) {
  const status = form.querySelector("[data-status]");
  const button = form.querySelector("button[type=submit]");
  const label = button.querySelector("[data-label]") ?? button;
  const idle = label.textContent;
  const show = (tone, key) => {
    if (!status) return;
    status.dataset.tone = tone;
    status.textContent = MESSAGES[key] ?? MESSAGES.unknown;
  };
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const email = String(data.get("email") ?? "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return show("error", "email");
    button.disabled = true;
    label.textContent = form.dataset.busy ?? "Joining…";
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
          elapsed: Math.round(performance.now() - openedAt),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.ok) {
        show("ok", "ok");
        label.textContent = form.dataset.done ?? "You're in";
        form.dispatchEvent(new CustomEvent("joined", { detail: { email } }));
        return;
      }
      show("error", body.error ?? "unknown");
    } catch {
      show("error", "network");
    }
    button.disabled = false;
    label.textContent = idle;
  });
}
