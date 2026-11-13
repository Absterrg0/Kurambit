// Ported from T3 Code (MIT, Copyright (c) T3 Tools Inc.).
import type { Dialog } from "@base-ui/react/dialog";

type FinalFocusHandler = Extract<Dialog.Popup.Props["finalFocus"], (...args: never[]) => unknown>;

// Documents whose focus is being handed back by a closing popup. A tooltip
// trigger that receives that focus stays closed: the person did not move to
// it, the popup they were in went away.
const returningFocus = new WeakSet<Document>();

function prepareFocusReturn(document: Document) {
  returningFocus.add(document);
  // Base UI restores focus in a microtask after close; two hops cover it.
  queueMicrotask(() => queueMicrotask(() => returningFocus.delete(document)));
}

export function isReturningFocus(document: Document) {
  return returningFocus.has(document);
}

/**
 * A popup's `finalFocus` that returns focus to the trigger only when focus was
 * still inside the popup (or nowhere) as it closed, and marks the return so the
 * trigger's tooltip does not open. If the person already clicked elsewhere,
 * focus stays there.
 */
export function tooltipSafeFinalFocus(
  finalFocus: Dialog.Popup.Props["finalFocus"],
  popupId: string,
): FinalFocusHandler {
  const handleFinalFocus: FinalFocusHandler = (closeType) => {
    const popup = document.getElementById(popupId);
    const focusContainer = popup?.closest("[data-base-ui-portal]") ?? popup;
    const activeElement = document.activeElement;
    if (
      (finalFocus === undefined || typeof finalFocus === "boolean") &&
      activeElement !== document.body &&
      !focusContainer?.contains(activeElement)
    ) {
      return false;
    }
    prepareFocusReturn(document);
    if (typeof finalFocus === "function") return finalFocus(closeType);
    return typeof finalFocus === "object" ? finalFocus.current : (finalFocus ?? true);
  };
  return handleFinalFocus;
}
