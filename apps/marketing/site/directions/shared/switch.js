// A [data-switch] group shows one [data-panel] at a time, chosen by its [data-show] controls.
// Videos inside panels start and stop through app.js, which watches their visibility.

for (const group of document.querySelectorAll("[data-switch]")) {
  const onHover = group.dataset.switch === "hover";
  const controls = group.querySelectorAll("[data-show]");
  const panels = group.querySelectorAll("[data-panel]");

  const select = (key) => {
    for (const control of controls) {
      control.setAttribute("aria-pressed", String(control.dataset.show === key));
    }
    for (const panel of panels) panel.hidden = panel.dataset.panel !== key;
  };

  for (const control of controls) {
    control.addEventListener("click", () => select(control.dataset.show));
    if (onHover) control.addEventListener("pointerenter", () => select(control.dataset.show));
    control.addEventListener("focus", () => onHover && select(control.dataset.show));
  }
}
