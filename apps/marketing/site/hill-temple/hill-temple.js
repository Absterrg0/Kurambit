// The Hill Temple's page: nothing downloads until Play (the click also lets the game start its
// audio), then a quiet progress line, then the canvas. No inline script: the site's CSP allows
// only same-origin scripts, so the engine's config travels in a JSON block.
//
// Before anything downloads, the page looks at the machine: WebGL 2, whether the browser draws on
// the graphics card at all, the desktop texture formats the game ships, and the memory hint. A
// machine that can't run it is told so plainly, here; one that can gets a quality tier (passed to
// the game as --tier) that the game's own first seconds may lower again.
(() => {
  const config = JSON.parse(document.getElementById("godot-config").textContent);
  // The engine's files (wasm, pack, audio worklets) come from games.kurambit.com (Cloudflare R2:
  // no transfer charges), one folder per build so the edge cache never serves a stale one. The
  // progress bar looks sizes up by those same URLs.
  const base = "https://games.kurambit.com/hill-temple/r4/";
  config.executable = base + config.executable;
  if (config.fileSizes) {
    for (const k of Object.keys(config.fileSizes)) config.fileSizes[base + k] = config.fileSizes[k];
  }
  const gate = document.querySelector("[data-gate]");
  const play = document.querySelector("[data-play]");
  const status = document.querySelector("[data-status]");
  const bar = document.querySelector("[data-bar]");
  const fill = document.querySelector("[data-bar-fill]");
  const credits = document.querySelector("[data-credits]");
  document.querySelector("[data-credits-open]").addEventListener("click", () => credits.showModal());

  const fail = (text) => {
    status.textContent = text;
    status.classList.add("error");
    bar.hidden = true;
    play.disabled = false;
    play.textContent = "Try again";
  };
  const refuse = (text) => {
    status.textContent = text;
    status.classList.add("error");
    play.disabled = true;
    play.hidden = true;
  };

  const missing = Engine.getMissingFeatures({ threads: false });
  if (missing.length) {
    refuse("This browser can't run it: " + missing.join(", ") + ". A current Chrome, Edge or Firefox on a desktop will.");
    return;
  }

  // the machine, as far as a page can see it
  const probe = document.createElement("canvas").getContext("webgl2");
  if (!probe) {
    refuse("This browser has WebGL 2 turned off or unavailable, and the game needs it. A current Chrome, Edge or Firefox with hardware acceleration on will run it.");
    return;
  }
  const dbg = probe.getExtension("WEBGL_debug_renderer_info");
  const gpu = String(dbg ? probe.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : probe.getParameter(probe.RENDERER));
  const s3tc = !!probe.getExtension("WEBGL_compressed_texture_s3tc");
  const memory = navigator.deviceMemory || 0; // GB, rounded and capped at 8 (Chromium only)
  probe.getExtension("WEBGL_lose_context")?.loseContext();
  const software = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(gpu);
  const integrated = /intel|iris|uhd|mali|adreno|powervr|apple|radeon\(tm\) graphics|radeon graphics|vega \d/i.test(gpu);
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  if (software) {
    refuse("This browser is drawing without the graphics card (" + gpu + "), so the game would barely move. Turn on hardware acceleration in the browser's settings and reload.");
    return;
  }
  if (memory && memory < 4) {
    refuse("This device reports " + memory + " GB of memory. The game needs about 1 GB of it free, so it would likely crash the tab here. A desktop or laptop with 4 GB or more will run it.");
    return;
  }

  const q = new URLSearchParams(location.search);
  let tier = integrated || !s3tc || (memory && memory <= 4) ? "low" : "high";
  if (integrated && memory >= 8 && s3tc) tier = "medium";
  if (["high", "medium", "low"].includes(q.get("tier"))) tier = q.get("tier");
  const args = ["--tier=" + tier];
  // ?playtest runs the game's own scripted route (the automated browser test uses it)
  if (q.has("playtest")) args.push("--playtest");
  else if (q.has("profile")) args.push("--profile");
  if (q.has("memreport")) args.push("--memreport");
  config.args = ["--"].concat(args);
  console.log("TIER", tier, "gpu=" + gpu, "memory=" + (memory || "?"), "s3tc=" + s3tc);

  if (mobile || !s3tc) {
    status.textContent =
      "Made for a desktop browser with a mouse and keyboard or a gamepad. On this device it may run slowly or not at all. About a 60 MB download.";
  }

  let engine = null;
  play.addEventListener("click", () => {
    play.disabled = true;
    play.textContent = "Loading";
    status.classList.remove("error");
    status.textContent = "Fetching the path and the temple.";
    bar.hidden = false;
    engine = engine || new Engine(config);
    engine
      .startGame({
        onProgress: (current, total) => {
          if (total > 0) {
            fill.style.width = Math.min(100, (100 * current) / total) + "%";
            status.textContent = Math.round(current / 1048576) + " of " + Math.round(total / 1048576) + " MB";
          } else {
            status.textContent = Math.round(current / 1048576) + " MB";
          }
        },
      })
      .then(() => {
        gate.classList.add("gone");
        document.body.classList.add("running");
        document.getElementById("canvas").focus();
      })
      .catch((err) => {
        console.error(err);
        fail("It didn't start: " + (err && err.message ? err.message : err) + ". Reload the page to try again.");
      });
  });
})();
