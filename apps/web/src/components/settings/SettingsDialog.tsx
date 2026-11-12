import { XIcon } from "lucide-react";
import { useRef, useState, type CSSProperties, type ReactNode } from "react";

import { useNativeTitlebarHeight } from "../../lib/windowControlsOverlay";
import { useCloseSettings } from "../sidebar/mainAppLocation";
import { Button } from "../ui/button";
import { Dialog, DialogClose, DialogPopup } from "../ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useThemeEditorStore } from "./themeEditorStore";

/**
 * Settings covers the app it opens over. Window shortcuts of the view behind it
 * yield while it is open, as they did when Settings replaced that view.
 */
export function isSettingsDialogOpen(): boolean {
  return document.querySelector("[data-settings-dialog]") !== null;
}

/**
 * Settings as a panel over the running app. The route opens it; closing it
 * (Esc, ✕, a backdrop click) animates out, then returns to the page that opened it.
 */
export function SettingsDialog({ children }: { children: ReactNode }) {
  const closeSettings = useCloseSettings();
  const themeEditorOpen = useThemeEditorStore((store) => store.session !== null);
  const [open, setOpen] = useState(true);
  // A text selection that ends on the backdrop is not a dismissal.
  const backdropPressRef = useRef(false);
  // Focus the panel, not its first control, so no stray focus ring shows on open.
  const popupRef = useRef<HTMLDivElement>(null);
  const nativeTitlebarHeight = useNativeTitlebarHeight();

  return (
    <Dialog
      open={open}
      // The theme editor floats outside this panel and needs focus while editing.
      modal={!themeEditorOpen}
      // Portaled layers outside the panel (toasts, confirm dialogs) are not backdrop presses.
      disablePointerDismissal
      onOpenChange={(nextOpen, details) => {
        if (nextOpen) return;
        // An Escape a field already handled (clearing a search, cancelling a shortcut
        // recording) is not a request to leave; Base UI closes on it regardless.
        if (details.reason === "escape-key" && details.event.defaultPrevented) return;
        // Closing unmounts a focused field without a blur, so rows that commit on
        // blur would drop what was typed. Blur first so they commit.
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && popupRef.current?.contains(focused)) focused.blur();
        setOpen(false);
      }}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) void closeSettings();
      }}
    >
      <DialogPopup
        variant="app-panel"
        showCloseButton={false}
        bottomStickOnMobile={false}
        ref={popupRef}
        initialFocus={popupRef}
        aria-label="Settings"
        data-settings-dialog=""
        viewportProps={{
          style: {
            "--app-modal-titlebar-height": `${nativeTitlebarHeight}px`,
          } as CSSProperties,
          onPointerDown: (event) => {
            backdropPressRef.current = event.target === event.currentTarget;
          },
          onClick: (event) => {
            if (backdropPressRef.current && event.target === event.currentTarget) setOpen(false);
            backdropPressRef.current = false;
          },
        }}
      >
        {/* Below sm the panel fills the window; this strip still moves it, as the titlebar does. */}
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 hidden h-(--app-modal-titlebar-height) [-webkit-app-region:drag] max-sm:block"
        />
        {children}
      </DialogPopup>
    </Dialog>
  );
}

export function SettingsDialogClose() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <DialogClose
            aria-label="Close settings"
            render={<Button size="icon-sm" variant="ghost" />}
          />
        }
      >
        <XIcon />
      </TooltipTrigger>
      <TooltipPopup side="bottom">Close (Esc)</TooltipPopup>
    </Tooltip>
  );
}
