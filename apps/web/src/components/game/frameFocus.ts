/**
 * Calls `read` whenever the keyboard may have moved between the app and a game's frame, once the
 * move has settled; returns the unsubscribe. A click into a frame sends the frame element no focus
 * event (the app's window only blurs), and a click on blank app space leaves the frame for the
 * body, which takes no focus event either: so a press anywhere in the app is read too, after the
 * press has moved the focus.
 */
export function watchFrameFocus(read: () => void): () => void {
  let settle = 0;
  const settled = () => {
    window.clearTimeout(settle);
    settle = window.setTimeout(read);
  };
  window.addEventListener("blur", settled);
  window.addEventListener("focus", read);
  document.addEventListener("focusin", read);
  document.addEventListener("pointerdown", settled, true);
  return () => {
    window.clearTimeout(settle);
    window.removeEventListener("blur", settled);
    window.removeEventListener("focus", read);
    document.removeEventListener("focusin", read);
    document.removeEventListener("pointerdown", settled, true);
  };
}
