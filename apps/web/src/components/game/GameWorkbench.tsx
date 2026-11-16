import type { RunId, ScopedThreadRef } from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";

import { isElectron } from "../../env";
import { useGameWorkspaceStore, type WorkbenchTab, WORKBENCH_TABS } from "../../gameWorkspaceStore";
import { cn } from "../../lib/utils";
import { XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../ui/tabs";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Text } from "../ui/text";
import { GameDecisionsPanel } from "./GameDecisions";
import { GameArtPanel } from "./GameArt";
import { GameTunePanel } from "./GameTune";
import { GameWorkbenchChecks } from "./GameWorkbenchChecks";
import { GameWorkbenchDebug } from "./GameWorkbenchDebug";
import { useStageConsoleCount } from "./gameStageWatch";

const LABEL: Record<WorkbenchTab, string> = {
  tune: "Tune",
  art: "Art",
  checks: "Checks",
  debug: "Debug",
  decisions: "Decisions",
};

const isTab = (value: unknown): value is WorkbenchTab =>
  (WORKBENCH_TABS as ReadonlyArray<unknown>).includes(value);

/**
 * The game's Workbench, a side panel of its own beside the game's column: one slim switch over
 * Tune, Art, Checks, Debug and Decisions. Only the open section is mounted, so one out of sight
 * costs nothing. `ownsTitleBarEnd`: nothing sits to its right, so on the desktop its top row runs
 * under the window's own controls.
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
  return (
    <Tabs
      value={tab}
      onValueChange={(next) => {
        if (isTab(next)) setTab(next);
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div
        className={cn(
          "flex h-(--workspace-topbar-height) shrink-0 items-stretch gap-2 border-b border-border ps-4 pe-2",
          isElectron && "drag-region",
          ownsTitleBarEnd && "wco:pr-(--workspace-native-controls-inset)",
        )}
      >
        <TabsList
          variant="underline"
          aria-label="Workbench"
          className="min-w-0 [-webkit-app-region:no-drag]"
        >
          {WORKBENCH_TABS.map((value) => (
            <TabsTab key={value} value={value}>
              {LABEL[value]}
              {value === "debug" ? <DebugCount threadRef={threadRef} /> : null}
            </TabsTab>
          ))}
        </TabsList>
        <span className="flex-1" />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Close the Workbench"
                className="self-center [-webkit-app-region:no-drag]"
                onClick={() => useGameWorkspaceStore.getState().setWorkbenchOpen(false)}
              />
            }
          >
            <XIcon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Close the Workbench</TooltipPopup>
        </Tooltip>
      </div>
      <TabsPanel value="tune" className="flex min-h-0 flex-1 flex-col">
        <GameTunePanel threadRef={threadRef} onAsk={onAsk} />
      </TabsPanel>
      <TabsPanel value="art" className="flex min-h-0 flex-1 flex-col">
        <GameArtPanel threadRef={threadRef} onAsk={onAsk} />
      </TabsPanel>
      <TabsPanel value="checks" className="flex min-h-0 flex-1 flex-col">
        <GameWorkbenchChecks threadRef={threadRef} onOpenTurnDiff={onOpenTurnDiff} />
      </TabsPanel>
      <TabsPanel value="debug" className="flex min-h-0 flex-1 flex-col">
        <GameWorkbenchDebug threadRef={threadRef} />
      </TabsPanel>
      <TabsPanel value="decisions" className="flex min-h-0 flex-1 flex-col">
        <GameDecisionsPanel threadRef={threadRef} />
      </TabsPanel>
    </Tabs>
  );
}

/**
 * The page's errors so far, else its warnings, as one quiet number after the word: in the error
 * colour only for errors. Nothing when there are none.
 */
function DebugCount({ threadRef }: { threadRef: ScopedThreadRef }) {
  const threadKey = scopedThreadKey(threadRef);
  const errors = useStageConsoleCount(threadKey, "error");
  const warnings = useStageConsoleCount(threadKey, "warn");
  if (errors === 0 && warnings === 0) return null;
  return (
    <Text
      variant="caption"
      tone={errors > 0 ? "destructive" : "muted"}
      numeric
      aria-label={
        errors > 0
          ? `${errors} ${errors === 1 ? "error" : "errors"}`
          : `${warnings} ${warnings === 1 ? "warning" : "warnings"}`
      }
    >
      {errors > 0 ? errors : warnings}
    </Text>
  );
}
