import type { RunId, ScopedThreadRef } from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import {
  ClipboardCheckIcon,
  ImageIcon,
  SlidersHorizontalIcon,
  type LucideIcon,
} from "lucide-react";

import { useEffect } from "react";

import { isElectron } from "../../env";
import { openGameTool } from "../../gameArrivalStore";
import { useGameWorkspaceStore, type WorkbenchTab, WORKBENCH_TABS } from "../../gameWorkspaceStore";
import { cn } from "../../lib/utils";

import { Tabs, TabsList, TabsPanel, TabsTab } from "../ui/tabs";
import { Text } from "../ui/text";
import { ArrivalDot } from "./ArrivalDot";
import { GameArtPanel } from "./GameArt";
import { GameTunePanel } from "./GameTune";
import { GameWorkbenchChecks } from "./GameWorkbenchChecks";
import { useStageConsoleCount } from "./gameStageWatch";
import { useGameArrivals } from "./useGameArrivals";

const SECTION: Record<WorkbenchTab, { readonly label: string; readonly icon: LucideIcon }> = {
  tune: { label: "Tune", icon: SlidersHorizontalIcon },
  art: { label: "Art", icon: ImageIcon },
  checks: { label: "Checks", icon: ClipboardCheckIcon },
};

const isTab = (value: unknown): value is WorkbenchTab =>
  (WORKBENCH_TABS as ReadonlyArray<unknown>).includes(value);

/**
 * The game's Workbench, a side panel of its own beside the game's column: Tune, Art and Checks as
 * one segmented control. A section shows once it has arrived (useGameArrivals), always in this
 * order, with a dot until it is first opened. The header's Workbench toggle and its key close it.
 * Only the open section is mounted, so one out of sight costs nothing. `ownsTitleBarEnd`: nothing
 * sits to its right, so on the desktop its top row runs under the window's own controls.
 */
export function GameWorkbench({
  threadRef,
  onAsk,
  onOpenTurnDiff,
  ownsTitleBarEnd,
}: {
  threadRef: ScopedThreadRef;
  onAsk: (text: string) => void;
  /** Opens T3's diff view on a turn, at a file: the path a chat turn's files take. */
  onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
  ownsTitleBarEnd: boolean;
}) {
  const tab = useGameWorkspaceStore((state) => state.workbenchTab);
  const setTab = useGameWorkspaceStore((state) => state.setWorkbenchTab);
  const open = useGameWorkspaceStore((state) => state.workbenchOpen);
  const arrivals = useGameArrivals(threadRef);
  const arrived = { tune: arrivals.tune, art: arrivals.art, checks: arrivals.checks };
  // Opened on a section that has not arrived (the toggle remembers the last one), it shows the
  // newest that has. A key for a section opens that section, which meets it.
  const fallback =
    WORKBENCH_TABS.find((each) => arrived[each].dot) ??
    WORKBENCH_TABS.find((each) => arrived[each].shown) ??
    tab;
  const shown = arrived[tab].shown ? tab : fallback;
  useEffect(() => {
    if (!open) return;
    if (shown !== tab) setTab(shown);
    openGameTool(shown);
  }, [open, shown, tab, setTab]);
  return (
    <Tabs
      value={shown}
      onValueChange={(next) => {
        if (isTab(next)) setTab(next);
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div
        className={cn(
          "flex h-(--workspace-topbar-height) shrink-0 items-center border-b border-border px-3",
          isElectron && "drag-region",
          ownsTitleBarEnd && "wco:pr-(--workspace-native-controls-inset)",
        )}
      >
        <TabsList aria-label="Workbench" className="w-full [-webkit-app-region:no-drag]">
          {WORKBENCH_TABS.filter((value) => value === shown || arrived[value].shown).map(
            (value) => {
              const Icon = SECTION[value].icon;
              return (
                <TabsTab key={value} value={value}>
                  <Icon aria-hidden="true" className="size-4 shrink-0" />
                  {SECTION[value].label}
                  {value === "checks" ? <ErrorCount threadRef={threadRef} /> : null}
                  <ArrivalDot on={arrived[value].dot && value !== shown} />
                </TabsTab>
              );
            },
          )}
        </TabsList>
      </div>
      <TabsPanel value="tune" className="flex min-h-0 flex-1 flex-col">
        <GameTunePanel threadRef={threadRef} onAsk={onAsk} />
      </TabsPanel>
      <TabsPanel value="art" className="flex min-h-0 flex-1 flex-col">
        <GameArtPanel threadRef={threadRef} onAsk={onAsk} />
      </TabsPanel>
      <TabsPanel value="checks" className="flex min-h-0 flex-1 flex-col">
        <GameWorkbenchChecks threadRef={threadRef} onAsk={onAsk} onOpenTurnDiff={onOpenTurnDiff} />
      </TabsPanel>
    </Tabs>
  );
}

/** The page's errors so far, as one number after Checks in the error colour; nothing with none. */
function ErrorCount({ threadRef }: { threadRef: ScopedThreadRef }) {
  const errors = useStageConsoleCount(scopedThreadKey(threadRef), "error");
  if (errors === 0) return null;
  return (
    <Text
      variant="caption"
      tone="destructive"
      numeric
      aria-label={`${errors} ${errors === 1 ? "error" : "errors"}`}
    >
      {errors}
    </Text>
  );
}
