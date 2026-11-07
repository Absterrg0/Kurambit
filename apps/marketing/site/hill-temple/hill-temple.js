// The Hill Temple's page: nothing downloads until Play (the click also lets the game start its
// audio), then a quiet progress line, then the canvas. No inline script: the site's CSP allows
// only same-origin scripts, so the engine's config travels in a JSON block.
(() => {
  const config = JSON.parse(document.getElementById("godot-config").textContent);
  // The page lives at /hill-temple (no trailing slash), so every engine file is fetched by an
  // absolute path; the progress bar looks sizes up by those same paths.
  const base = "/hill-temple/";
  config.executable = base + config.executable;
  if (config.fileSizes) {
    for (const k of Object.keys(config.fileSizes)) config.fileSizes[base + k] = config.fileSizes[k];
  }
  // ?playtest runs the game's own scripted route (the automated browser test uses it)
  const q = new URLSearchParams(location.search);
  if (q.has("playtest")) config.args = ["--", "--playtest"];
  else if (q.has("profile")) config.args = ["--", "--profile"];
  const gate = document.querySelector("[data-gate]");
  const play = document.querySelector("[data-play]");
  const status = document.querySelector("[data-status]");
  const bar = document.querySelector("[data-bar]");
  const fill = document.querySelector("[data-bar-fill]");
  const credits = document.querySelector("[data-credits]");
  document
    .querySelector("[data-credits-open]")
    .addEventListener("click", () => credits.showModal());

  const fail = (text) => {
    status.textContent = text;
    status.classList.add("error");
    bar.hidden = true;
    play.disabled = false;
    play.textContent = "Try again";
  };

  const missing = Engine.getMissingFeatures({ threads: false });
  if (missing.length) {
    play.disabled = true;
    fail(
      "This browser can't run it: " +
        missing.join(", ") +
        ". A current Chrome, Edge or Firefox on a desktop will.",
    );
    play.disabled = true;
    return;
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
            status.textContent =
              Math.round(current / 1048576) + " of " + Math.round(total / 1048576) + " MB";
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
        fail(
          "It didn't start: " +
            (err && err.message ? err.message : err) +
            ". Reload the page to try again.",
        );
      });
  });
})();
