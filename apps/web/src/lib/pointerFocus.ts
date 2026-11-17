/**
 * A segmented control's ring is for the keyboard. Chrome keeps :focus-visible on a control that
 * was focused from the keyboard (a shortcut, the palette) or programmatically after typing, even
 * once the person goes on with the mouse: the ring then sits on a segment they just clicked.
 * A pointer press marks the control `data-pointer` until the next key or blur, and the ring
 * yields to it.
 */
export const pointerFocusHandlers = <
  P extends { readonly currentTarget: HTMLElement },
  K extends { readonly currentTarget: HTMLElement },
  B extends { readonly currentTarget: HTMLElement },
>(own: {
  readonly onPointerDown?: ((event: P) => void) | undefined;
  readonly onKeyDown?: ((event: K) => void) | undefined;
  readonly onBlur?: ((event: B) => void) | undefined;
}) => ({
  onPointerDown: (event: P) => {
    event.currentTarget.dataset.pointer = "";
    own.onPointerDown?.(event);
  },
  onKeyDown: (event: K) => {
    delete event.currentTarget.dataset.pointer;
    own.onKeyDown?.(event);
  },
  onBlur: (event: B) => {
    delete event.currentTarget.dataset.pointer;
    own.onBlur?.(event);
  },
});

/** The classes that let a pointer-marked control drop its keyboard ring. */
export const POINTER_FOCUS_QUIET =
  "data-pointer:focus-visible:outline-none data-pointer:focus-visible:ring-0";
