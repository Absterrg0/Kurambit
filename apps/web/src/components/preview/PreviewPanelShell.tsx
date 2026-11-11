import {
  type CSSProperties,
  type FocusEvent,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  getPreviewPanelMaxWidth,
  type PreviewPanelInlineSize,
  usePreviewPanelInlineSize,
} from "~/hooks/usePreviewPanelInlineSize";
import { RESIZABLE_WIDTH_PROPERTY } from "~/hooks/useResizableWidth";

export { getPreviewPanelMaxWidth };
import { cn } from "~/lib/utils";

import { RightPanelResizeHandle } from "./RightPanelResizeHandle";

export type PreviewPanelMode = "inline" | "sheet" | "sidebar" | "embedded";

interface PreviewPanelShellProps {
  mode: PreviewPanelMode;
  maximized?: boolean;
  inlineSize?: PreviewPanelInlineSize;
  open?: boolean;
  /**
   * Callers embedding this shell for a different surface (e.g. the pull
   * requests page) should pass their own key so resizing one panel doesn't
   * clobber the other's remembered width.
   */
  widthStorageKey?: string;
  defaultWidth?: number;
  children: ReactNode;
}

export function PreviewPanelShell(props: PreviewPanelShellProps) {
  if (props.inlineSize) {
    return <PreviewPanelShellFrame {...props} inlineSize={props.inlineSize} />;
  }

  return <ResizablePreviewPanelShell {...props} />;
}

function ResizablePreviewPanelShell(props: PreviewPanelShellProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const inlineSize = usePreviewPanelInlineSize(hostRef, {
    enabled: props.mode === "inline" && !props.maximized,
    widthStorageKey: props.widthStorageKey,
    defaultWidth: props.defaultWidth,
  });
  return <PreviewPanelShellFrame {...props} inlineSize={inlineSize} hostRef={hostRef} />;
}

// Closing the panel hands focus back to where it entered from, or to the panel
// toggle when that place is gone or hidden, so focus never falls to the body.
function returnFocus(host: HTMLElement, origin: HTMLElement | null) {
  const { ownerDocument } = host;
  // focus() is a no-op on a disabled origin, so activeElement says whether it took.
  if (origin?.isConnected && !host.contains(origin) && origin.checkVisibility()) {
    origin.focus({ preventScroll: true });
    if (ownerDocument.activeElement === origin) return;
  }
  ownerDocument.querySelector<HTMLElement>("[data-right-panel-toggle]")?.focus();
}

function PreviewPanelShellFrame(
  props: PreviewPanelShellProps & {
    inlineSize: PreviewPanelInlineSize;
    hostRef?: RefObject<HTMLDivElement | null>;
  },
) {
  const isInline = props.mode === "inline";
  const collapsible = isInline && props.open !== undefined;
  const open = props.open ?? true;
  const maximized = props.maximized ?? false;
  const localHostRef = useRef<HTMLDivElement | null>(null);
  const hostRef = props.hostRef ?? localHostRef;
  const { width, handlers } = props.inlineSize;
  const focusOrigin = useRef<HTMLElement | null>(null);
  const lastBlurred = useRef<EventTarget | null>(null);
  // Focus moving within the panel (portalled menus included) first blurs one of
  // its own elements, so only focus arriving from outside records an origin.
  const rememberFocusOrigin = (event: FocusEvent<HTMLDivElement>) => {
    const from = event.relatedTarget;
    if (from === null || from === lastBlurred.current) return;
    focusOrigin.current = from instanceof HTMLElement ? from : null;
  };
  // Focus leaves before the host goes inert, while its origin is still reachable;
  // inert set by React in the same commit would drop focus on the body first.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !collapsible) return;
    if (!open) {
      if (host.contains(host.ownerDocument.activeElement)) {
        returnFocus(host, focusOrigin.current);
      }
      focusOrigin.current = null;
    }
    host.toggleAttribute("inert", !open);
  }, [collapsible, open, hostRef]);
  // Derive suppression before the layout commits so the browser never creates
  // a width transition for resize or maximize changes.
  const [layoutTransition, setLayoutTransition] = useState(() => ({
    open,
    width,
    maximized,
    suppressed: false,
  }));
  if (
    layoutTransition.open !== open ||
    layoutTransition.width !== width ||
    layoutTransition.maximized !== maximized
  ) {
    setLayoutTransition({
      open,
      width,
      maximized,
      suppressed:
        collapsible &&
        layoutTransition.open === open &&
        (layoutTransition.width !== width || layoutTransition.maximized !== maximized),
    });
  }
  const suppressWidthTransition = layoutTransition.suppressed;
  useLayoutEffect(() => {
    if (!suppressWidthTransition) return;
    let restoreFrame = 0;
    const paintFrame = window.requestAnimationFrame(() => {
      restoreFrame = window.requestAnimationFrame(() => {
        setLayoutTransition((current) => ({ ...current, suppressed: false }));
      });
    });
    return () => {
      window.cancelAnimationFrame(paintFrame);
      window.cancelAnimationFrame(restoreFrame);
    };
  }, [suppressWidthTransition]);
  return (
    <div
      ref={hostRef}
      onFocus={rememberFocusOrigin}
      onBlur={(event) => {
        lastBlurred.current = event.target;
      }}
      className={cn(
        "relative flex h-full min-h-0 min-w-0 max-w-full flex-col self-stretch bg-background",
        isInline
          ? maximized
            ? "flex-1 border-l border-border"
            : "shrink-0 border-l border-border"
          : "w-full",
        collapsible &&
          "[[data-panel-animations=true]_&]:transition-[width] [[data-panel-animations=true]_&]:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:ease-out",
        collapsible && open && "[[data-panel-animations=true]_&]:starting:w-0!",
        collapsible && !open && "pointer-events-none",
      )}
      style={
        isInline
          ? ({
              [RESIZABLE_WIDTH_PROPERTY]: `${width}px`,
              width: maximized
                ? "100%"
                : collapsible && !open
                  ? "0px"
                  : `var(${RESIZABLE_WIDTH_PROPERTY})`,
              transitionDuration: suppressWidthTransition ? "0ms" : undefined,
            } as CSSProperties)
          : undefined
      }
      data-preview-panel-mode={props.mode}
      data-preview-panel-maximized={maximized ? "true" : "false"}
    >
      {isInline && !maximized ? <RightPanelResizeHandle handlers={handlers} /> : null}
      <div className={cn("h-full min-h-0 w-full", collapsible && "overflow-clip")}>
        <div
          className="flex h-full min-h-0 min-w-0 flex-col"
          style={
            collapsible && !maximized
              ? { width: `calc(var(${RESIZABLE_WIDTH_PROPERTY}) - 1px)` }
              : undefined
          }
        >
          {props.children}
        </div>
      </div>
    </div>
  );
}
