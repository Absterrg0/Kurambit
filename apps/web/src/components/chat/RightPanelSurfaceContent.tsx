import type {
  EditorId,
  EnvironmentId,
  PreviewAnnotationPayload,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { lazy, Suspense } from "react";
import type { ComposerImageAttachment, DraftId } from "../../composerDraftStore";
import type { ShortcutMatchContext } from "../../keybindings";
import { type RightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import {
  PersistentThreadTerminalPanel,
  type PersistentThreadTerminalPanelProps,
} from "../PersistentThreadTerminals";

const GamePanel = lazy(() =>
  import("../game/GamePanel").then((module) => ({ default: module.GamePanel })),
);
const PreviewPanel = lazy(() =>
  import("../preview/PreviewPanel").then((module) => ({ default: module.PreviewPanel })),
);
const DiffPanel = lazy(() => import("../DiffPanel"));
const FilePreviewPanel = lazy(() => import("../files/FilePreviewPanel"));

export type RightPanelTerminalProps = Omit<
  PersistentThreadTerminalPanelProps,
  "visible" | "threadRef" | "surface"
>;

export interface RightPanelFileProps {
  readonly projectName: string | null;
  readonly workspaceRoot: string | undefined;
  readonly availableEditors: ReadonlyArray<EditorId>;
  readonly pendingSurfaceIds: ReadonlySet<string>;
  readonly onOpenFile: (relativePath: string) => void;
  readonly onPendingChange: (relativePath: string, pending: boolean) => void;
}

/** The body of the thread's right panel for the surface it is showing. */
export function RightPanelSurfaceContent(props: {
  readonly surface: RightPanelSurface | null;
  readonly activeSurfaceId: string | null;
  readonly threadRef: ScopedThreadRef;
  readonly environmentId: EnvironmentId;
  readonly visible: boolean;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly configuredPreviewUrls: ReadonlyArray<string>;
  readonly workspaceMutationId: string | null;
  readonly getShortcutContext: () => ShortcutMatchContext;
  readonly onSendAnnotation: (
    annotation: PreviewAnnotationPayload,
    image: ComposerImageAttachment | null,
  ) => void;
  readonly onCloseSurface: (surface: RightPanelSurface) => void;
  readonly terminal: RightPanelTerminalProps;
  readonly files: RightPanelFileProps;
}) {
  const { surface, threadRef, visible } = props;
  if (surface === null) return null;
  switch (surface.kind) {
    case "game":
      return (
        <Suspense fallback={null}>
          <GamePanel threadRef={threadRef} visible={visible} />
        </Suspense>
      );
    case "preview":
      return (
        <Suspense fallback={null}>
          <PreviewPanel
            mode="embedded"
            threadRef={threadRef}
            tabId={surface.resourceId}
            configuredUrls={props.configuredPreviewUrls}
            visible={visible}
            onSendAnnotation={props.onSendAnnotation}
          />
        </Suspense>
      );
    case "terminal":
      return (
        <PersistentThreadTerminalPanel
          {...props.terminal}
          visible={visible}
          threadRef={threadRef}
          surface={surface}
        />
      );
    case "diff":
      return (
        <Suspense fallback={null}>
          <DiffPanel
            key={scopedThreadKey(threadRef)}
            mode="embedded"
            composerDraftTarget={props.composerDraftTarget}
            workspaceMutationId={props.workspaceMutationId}
          />
        </Suspense>
      );
    case "files":
    case "file": {
      const files = props.files;
      const attachment = surface.kind === "file" ? surface.attachment : undefined;
      if (!attachment && (files.projectName === null || !files.workspaceRoot)) return null;
      return (
        <Suspense fallback={null}>
          <FilePreviewPanel
            key={`${props.environmentId}:${
              attachment ? `attachment:${attachment.id}` : files.workspaceRoot
            }`}
            environmentId={props.environmentId}
            cwd={files.workspaceRoot ?? ""}
            projectName={files.projectName ?? ""}
            threadRef={threadRef}
            composerDraftTarget={props.composerDraftTarget}
            keybindings={props.keybindings}
            availableEditors={files.availableEditors}
            relativePath={surface.kind === "file" ? surface.relativePath : null}
            {...(attachment ? { attachment } : {})}
            revealLine={surface.kind === "file" ? (surface.revealLine ?? null) : null}
            revealRequestId={surface.kind === "file" ? surface.revealRequestId : 0}
            onOpenFile={files.onOpenFile}
            onNavigateFolder={(relativePath, folderTrail, keepSource) =>
              useRightPanelStore
                .getState()
                .navigateFolder(threadRef, surface.id, relativePath, folderTrail, keepSource)
            }
            folderTrail={surface.folderTrail}
            onPendingChange={files.onPendingChange}
            selectedFilePending={surface.kind === "file" && files.pendingSurfaceIds.has(surface.id)}
            workspaceMutationId={props.workspaceMutationId}
          />
        </Suspense>
      );
    }
  }
}
