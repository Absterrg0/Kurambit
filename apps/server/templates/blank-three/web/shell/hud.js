// The HUD kit: ctx.ui. Every widget is found by its name, so call these every
// frame from update(); text is written only when it changes. The kit lives in
// the run's hud layer, so Retry starts it empty, and its timers run on game
// time, so pause freezes them. Everything it shows is plain text the studio
// probe reads, the same HUD a tester and the player see.
//
//   ctx.ui.counter("Gems", gems, 5);                 // "Gems 3 / 5", pops when it changes
//   ctx.ui.counter("Score", score);                  // "Score 1200"
//   ctx.ui.bar("Health", hp, 3);                     // hearts up to 10, a bar above that
//   ctx.ui.timer("Time", secondsLeft);               // "Time 1:05"
//   ctx.ui.objective("Light all five shrines");      // top centre; "" hides it
//   ctx.ui.toast("Gate opened!");                    // on the event: centre, queued, ~2 s each
//   ctx.ui.hint("{move_up}{move_left}{move_down}{move_right} to move", { until: () => moved });
//   ctx.ui.hint("Press {jump} to jump");             // {action} becomes its current key
//
// A hint shows once per visit, until `until()` turns true or `seconds` pass
// (default 6). Give a counter `{ icon: "assets/ui/gem.png" }` for a picture.
import { Juice } from "./juice.js";

const TOAST_S = 1.8;
const FADE_S = 0.25;
const TOAST_AGAIN_S = 4;
const MAX_TOASTS = 3;
// A value that changes every frame (a ticking score) pops at most this often.
const POP_GAP_S = 0.3;

export function createHud(layer, input) {
  const area = (name) => {
    const element = document.createElement("div");
    element.className = `hud-${name}`;
    layer.append(element);
    return element;
  };
  let stats = null;
  let centre = null;
  let bottom = null;
  let top = null;
  const widgets = new Map();
  const toasts = [];
  // Toast text that ended a moment ago, with the seconds until it may show again.
  const recent = new Map();
  const hints = [];
  let toast = null;
  let hint = null;
  // Game time, for the pop throttle.
  let now = 0;
  const pop = (entry, amount) => {
    if (now - (entry.poppedAt ?? -Infinity) < POP_GAP_S) return;
    entry.poppedAt = now;
    Juice.pop(entry.element, amount, amount);
  };

  const write = (element, text) => {
    if (element.textContent !== text) element.textContent = text;
  };
  const widget = (name, kind, build) => {
    let entry = widgets.get(name);
    if (entry === undefined || entry.kind !== kind) {
      entry?.element.remove();
      stats ??= area("stats");
      const element = document.createElement("div");
      element.className = `hud-widget hud-${kind}`;
      stats.append(element);
      entry = { kind, element, value: undefined, ...build(element) };
      widgets.set(name, entry);
    }
    return entry;
  };
  const labelled = (text) =>
    text.replace(/\{([a-z_]+)\}/gi, (whole, action) => {
      try {
        return input.label(action);
      } catch {
        return whole;
      }
    });

  return {
    counter(name, value, max, { icon } = {}) {
      const entry = widget(name, "counter", (element) => {
        if (icon) {
          const image = document.createElement("img");
          image.src = icon;
          image.alt = "";
          element.append(image);
        }
        const text = document.createElement("span");
        element.append(text);
        return { text };
      });
      const shown = max === undefined ? `${name} ${value}` : `${name} ${value} / ${max}`;
      if (entry.value !== undefined && entry.value !== value) pop(entry, 0.18);
      entry.value = value;
      write(entry.text, shown);
    },
    bar(name, value, max) {
      const hearts = max <= 10;
      const entry = widget(name, hearts ? "hearts" : "bar", (element) => {
        const text = document.createElement("span");
        element.append(text);
        if (hearts) {
          const pips = document.createElement("span");
          pips.className = "hud-pips";
          element.append(pips);
          return { text, pips };
        }
        const track = document.createElement("div");
        track.className = "hud-track";
        const fill = document.createElement("div");
        track.append(fill);
        element.append(track);
        return { text, fill };
      });
      const clamped = Math.max(0, Math.min(max, value));
      if (hearts) {
        const full = Math.round(clamped);
        write(entry.text, `${name} `);
        write(entry.pips, `${"♥".repeat(full)}${"♡".repeat(Math.max(0, max - full))}`);
      } else {
        write(entry.text, `${name} ${Math.round(clamped)} / ${max}`);
        const width = `${(clamped / max) * 100}%`;
        if (entry.fill.style.width !== width) entry.fill.style.width = width;
      }
      if (entry.value !== undefined && clamped < entry.value) pop(entry, 0.15);
      entry.value = clamped;
    },
    timer(name, seconds) {
      const entry = widget(name, "timer", (element) => ({ text: element }));
      const whole = Math.max(0, Math.ceil(seconds));
      write(entry.text, `${name} ${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`);
    },
    objective(text) {
      top ??= area("objective");
      write(top, text);
      top.hidden = text === "";
    },
    toast(text, seconds = TOAST_S) {
      // Called from a condition every frame, the same text would show forever:
      // it waits while it shows or queues, and a call within a few seconds of
      // it ending restarts that wait, so it shows again only after a real gap.
      if (recent.has(text)) {
        recent.set(text, TOAST_AGAIN_S);
        return;
      }
      if ((toast !== null && centre?.textContent === text) || toasts.some((t) => t.text === text))
        return;
      // Text that changes every frame would queue without end: keep the newest few.
      if (toasts.length >= MAX_TOASTS) toasts.shift();
      toasts.push({ text, seconds });
    },
    hint(text, { until = null, seconds = 6 } = {}) {
      if (shownHints.has(text) || hints.some((h) => h.key === text) || hint?.key === text) return;
      hints.push({ key: text, until: typeof until === "function" ? until : null, seconds });
    },
    /** The shell's tick, on game time after update(). */
    update(dt) {
      now += dt;
      for (const [text, left] of recent)
        if (left - dt <= 0) recent.delete(text);
        else recent.set(text, left - dt);
      if (toast === null && toasts.length > 0) {
        const next = toasts.shift();
        centre ??= area("toast");
        write(centre, next.text);
        centre.hidden = false;
        centre.classList.add("shown");
        toast = { left: next.seconds };
      } else if (toast !== null && (toast.left -= dt) <= 0) {
        centre.classList.remove("shown");
        if (toast.left <= -FADE_S) {
          // Hidden, not only transparent: the probe reads text that is on screen.
          centre.hidden = true;
          recent.set(centre.textContent, TOAST_AGAIN_S);
          toast = null;
        }
      }
      if (hint === null && hints.length > 0) {
        const next = hints.shift();
        // Shown counts from here: a hint queued when the run ended comes back next run.
        shownHints.add(next.key);
        bottom ??= area("hint");
        write(bottom, labelled(next.key));
        bottom.hidden = false;
        bottom.classList.add("shown");
        hint = { ...next, left: next.seconds };
      } else if (hint !== null) {
        hint.left -= dt;
        if (hint.left > 0 && hint.until?.() === true) hint.left = 0;
        if (hint.left <= 0) bottom.classList.remove("shown");
        if (hint.left <= -FADE_S) {
          bottom.hidden = true;
          hint = null;
        }
      }
    },
  };
}

// A hint is onboarding: once per visit, not once per run.
const shownHints = new Set();
