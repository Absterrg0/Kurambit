import "@fontsource-variable/geist";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "./styles.css";

for (const node of document.querySelectorAll("[data-year]")) {
  node.textContent = String(new Date().getFullYear());
}
