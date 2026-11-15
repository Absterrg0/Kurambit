// node shot.mjs <url> <out.png> [waitMs=4000] [width=1600] [height=900]
// Headless Chromium with WebGL on the GPU (EGL), never a display. Prints the page's console errors.
import { chromium } from "{PLAYWRIGHT}";
const [url, out, waitMs = "4000", w = "1600", h = "900"] = process.argv.slice(2);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k !== "DISPLAY" && k !== "WAYLAND_DISPLAY"),
);
const browser = await chromium.launch({
  headless: true,
  args: ["--headless=new", "--use-angle=gl-egl", "--ignore-gpu-blocklist", "--mute-audio"],
  env,
});
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") console.log(`[${m.type()}]`, m.text());
});
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(+waitMs);
await page.screenshot({ path: out });
console.log("saved", out);
await browser.close();
