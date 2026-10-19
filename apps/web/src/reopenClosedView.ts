import type { OpenPreviewMutation } from "./browser/openFileInPreview";
import type { ClosedView, ClosedViewEntry } from "./closedViewStore";
import { openPreviewSession } from "./components/preview/openPreviewSession";
import { type ThreadRightPanelState, useRightPanelStore } from "./rightPanelStore";

export interface ReopenOwnerState {
  environmentKnown: boolean;
  catalogReady: boolean;
  ownerExists: boolean;
  shellLive: boolean;
  panel: ThreadRightPanelState;
}

export function planNextReopen(
  entries: readonly ClosedViewEntry[],
  ownerState: (entry: ClosedViewEntry) => ReopenOwnerState,
): { drop: ClosedViewEntry[]; restore: ClosedViewEntry | null } {
  const drop: ClosedViewEntry[] = [];
  for (const entry of entries) {
    const owner = ownerState(entry);
    if (!owner.environmentKnown) {
      if (!owner.catalogReady) break;
      drop.push(entry);
      continue;
    }
    if (!owner.ownerExists) {
      if (owner.shellLive) continue;
      break;
    }
    const alreadyOpen =
      entry.kind === "panel-tab"
        ? owner.panel.isOpen && owner.panel.surfaces.some((s) => s.id === entry.surface.id)
        : owner.panel.surfaces.some(
            (s) => s.kind === "preview" && s.resourceId === entry.snapshot.tabId,
          );
    if (alreadyOpen) {
      drop.push(entry);
      continue;
    }
    return { drop, restore: entry };
  }
  return { drop, restore: null };
}

export async function reopenClosedView(
  view: ClosedView,
  options: {
    openPreview: OpenPreviewMutation;
    workspaceAvailable: boolean;
  },
): Promise<boolean> {
  const panels = useRightPanelStore.getState();
  const ref = view.threadRef;

  if (view.kind === "browser") {
    const url = view.snapshot.navStatus._tag === "Idle" ? undefined : view.snapshot.navStatus.url;
    const result = await openPreviewSession({
      openPreview: options.openPreview,
      threadRef: ref,
      ...(url === undefined ? {} : { url }),
      ...(view.snapshot.viewport === undefined ? {} : { viewport: view.snapshot.viewport }),
      ...(view.snapshot.profileId === undefined ? {} : { profileId: view.snapshot.profileId }),
    });
    if (result._tag === "Failure") return false;
    panels.openBrowser(ref, result.value.tabId);
    return true;
  }
  const surface = view.surface;
  if (
    !options.workspaceAvailable &&
    (surface.kind === "files" || (surface.kind === "file" && !surface.attachment))
  )
    return false;
  switch (surface.kind) {
    case "preview":
      if (surface.resourceId !== null) return false;
      panels.openBrowser(ref, null);
      break;
    case "file":
      if (surface.attachment) panels.openAttachment(ref, surface.attachment);
      else panels.openFile(ref, surface.relativePath, surface.revealLine ?? undefined);
      break;
    default:
      panels.open(ref, surface.kind);
  }
  return true;
}
