"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { useId } from "react";
import { cn } from "~/lib/utils";
import { Button, type ButtonVariant } from "~/components/ui/button";
import {
  DIALOG_APP_PANEL_BACKDROP_CLASS,
  DIALOG_APP_PANEL_POPUP_CLASS,
  DIALOG_BACKDROP_CLASS,
  DIALOG_MEDIA_BACKDROP_CLASS,
  DIALOG_MEDIA_POPUP_CLASS,
  DIALOG_MOBILE_SHEET_CLASS,
  DIALOG_POPUP_CLASS,
} from "~/components/ui/dialog-styles";
import { ScrollArea } from "~/components/ui/scroll-area";
import { tooltipSafeFinalFocus } from "~/components/ui/focus-return";

type InitialFocus = Extract<
  DialogPrimitive.Popup.Props["initialFocus"],
  (...args: never[]) => unknown
>;

// A dialog with a DialogAction opens with focus on it, so Enter takes the
// primary action. Touch opens keep Base UI's default, which avoids raising the
// on-screen keyboard.
function dialogActionInitialFocus(
  initialFocus: DialogPrimitive.Popup.Props["initialFocus"],
  popupId: string,
): DialogPrimitive.Popup.Props["initialFocus"] {
  if (initialFocus !== undefined) return initialFocus;
  const focusAction: InitialFocus = (openType) => {
    if (openType === "touch") return true;
    return (
      document
        .getElementById(popupId)
        ?.querySelector<HTMLElement>(
          '[data-slot="dialog-action"]:not(:disabled):not([aria-disabled="true"])',
        ) ?? true
    );
  };
  return focusAction;
}

const Dialog = DialogPrimitive.Root;

const DialogPortal = DialogPrimitive.Portal;

function DialogTrigger(props: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogClose(props: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogBackdrop({
  className,
  variant = "default",
  ...props
}: DialogPrimitive.Backdrop.Props & { variant?: "default" | "media" | "panel" }) {
  return (
    <DialogPrimitive.Backdrop
      forceRender
      className={cn(
        variant === "media"
          ? DIALOG_MEDIA_BACKDROP_CLASS
          : variant === "panel"
            ? DIALOG_APP_PANEL_BACKDROP_CLASS
            : DIALOG_BACKDROP_CLASS,
        className,
      )}
      data-slot="dialog-backdrop"
      {...props}
    />
  );
}

function DialogViewport({ className, ...props }: DialogPrimitive.Viewport.Props) {
  return (
    <DialogPrimitive.Viewport
      className={cn(
        "fixed inset-0 z-50 grid grid-rows-[1fr_auto_1fr] justify-items-center p-4",
        className,
      )}
      data-slot="dialog-viewport"
      {...props}
    />
  );
}

function DialogPopup({
  className,
  children,
  showCloseButton = true,
  bottomStickOnMobile = true,
  variant = "default",
  viewportProps,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  bottomStickOnMobile?: boolean;
  variant?: "default" | "media" | "app-panel";
  viewportProps?: Omit<DialogPrimitive.Viewport.Props, "className">;
}) {
  const defaultId = useId();
  const popupId = props.id ?? defaultId;
  return (
    <DialogPortal>
      {/* Media opens from inside other overlays (a composer chip, a popover), so it sits above them. */}
      <DialogBackdrop
        className={variant === "media" ? "z-[60]" : undefined}
        variant={variant === "app-panel" ? "panel" : variant}
      />
      <DialogViewport
        {...viewportProps}
        className={cn(
          bottomStickOnMobile && "max-sm:grid-rows-[1fr_auto] max-sm:p-0 max-sm:pt-12",
          variant === "media" &&
            "z-[60] grid-rows-1 place-items-center px-4 py-6 [-webkit-app-region:no-drag]",
          // Clears native window controls (macOS traffic lights, the Windows caption buttons),
          // which the owner reports as --app-modal-titlebar-height, and anything it keeps
          // visible on the left, reported as --app-modal-left-inset.
          variant === "app-panel" &&
            "grid-rows-1 items-center max-sm:p-0 sm:p-6 sm:pt-[max(1.5rem,var(--app-modal-titlebar-height,0px))] sm:pl-[calc(var(--app-modal-left-inset,0px)+1.5rem)] lg:p-10 lg:pl-[calc(var(--app-modal-left-inset,0px)+2.5rem)]",
        )}
      >
        <DialogPrimitive.Popup
          className={cn(
            variant === "media"
              ? DIALOG_MEDIA_POPUP_CLASS
              : variant === "app-panel"
                ? DIALOG_APP_PANEL_POPUP_CLASS
                : DIALOG_POPUP_CLASS,
            variant !== "app-panel" && "row-start-2 text-popover-foreground",
            variant === "default" && "max-h-full max-w-lg",
            bottomStickOnMobile && DIALOG_MOBILE_SHEET_CLASS,
            className,
          )}
          data-slot="dialog-popup"
          {...props}
          id={popupId}
          initialFocus={dialogActionInitialFocus(props.initialFocus, popupId)}
          finalFocus={tooltipSafeFinalFocus(props.finalFocus, popupId)}
        >
          {children}
          {showCloseButton && (
            <DialogPrimitive.Close
              aria-label="Close"
              className="absolute end-2 top-2"
              render={<Button size="icon" variant="ghost" />}
            >
              <XIcon />
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Popup>
      </DialogViewport>
    </DialogPortal>
  );
}

/**
 * The dialog's primary action: a Button that takes focus when the dialog
 * opens. Destructive actions never take focus, so Enter cannot delete.
 */
function DialogAction(
  props: Omit<React.ComponentProps<typeof Button>, "variant"> & {
    variant?: Exclude<ButtonVariant, `${string}destructive${string}`>;
  },
) {
  return <Button data-slot="dialog-action" {...props} />;
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 p-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-panel])]:pb-3 max-sm:pb-4",
        className,
      )}
      data-slot="dialog-header"
      {...props}
    />
  );
}

function DialogFooter({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & {
  variant?: "default" | "bare";
}) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 px-6 sm:flex-row sm:justify-end sm:rounded-b-[calc(var(--radius-2xl)-1px)]",
        variant === "default" && "border-t bg-muted/72 py-4",
        variant === "bare" && "py-4",
        className,
      )}
      data-slot="dialog-footer"
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      className={cn("wrap-anywhere text-title text-strong-foreground", className)}
      data-slot="dialog-title"
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      className={cn("text-body text-muted-foreground", className)}
      data-slot="dialog-description"
      {...props}
    />
  );
}

function DialogPanel({
  className,
  scrollFade = true,
  ...props
}: React.ComponentProps<"div"> & { scrollFade?: boolean }) {
  return (
    <ScrollArea scrollFade={scrollFade}>
      <div
        className={cn(
          "space-y-4 p-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-header])]:pt-1 in-[[data-slot=dialog-popup]:has([data-slot=dialog-footer]:not(.border-t))]:pb-1",
          className,
        )}
        data-slot="dialog-panel"
        {...props}
      />
    </ScrollArea>
  );
}

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogAction,
  dialogActionInitialFocus,
  DialogBackdrop,
  DialogBackdrop as DialogOverlay,
  DialogPopup,
  DialogPopup as DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogViewport,
};
