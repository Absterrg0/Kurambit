import type { ScopedThreadRef } from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";

import { isElectron } from "../../env";
import { useGameWorkspaceStore, type WorkbenchTab, WORKBENCH_TABS } from "../../gameWorkspaceStore";
import { cn } from "../../lib/utils";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../ui/tabs";
import { Text } from "../ui/text";
import { GameDecisionsPanel } from "./GameDecisions";
import { GameLookPanel } from "./GameInspector";
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
  ownsTitleBarEnd,
}: {
  threadRef: ScopedThreadRef;
  onAsk: (text: string) => void;
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
          "flex h-(--workspace-topbar-height) shrink-0 items-center px-2",
          isElectron && "drag-region",
          ownsTitleBarEnd && "wco:pr-(--workspace-native-controls-inset)",
        )}
      >
        <TabsList aria-label="Workbench" className="w-full [-webkit-app-region:no-drag]">
          {WORKBENCH_TABS.map((value) => (
            <TabsTab key={value} value={value}>
              {LABEL[value]}
              {value === "debug" ? <DebugCount threadRef={threadRef} /> : null}
            </TabsTab>
          ))}
        </TabsList>
      </div>
      <TabsPanel value="tune" className="flex min-h-0 flex-1 flex-col">
        <GameTunePanel threadRef={threadRef} onAsk={onAsk} />
      </TabsPanel>
      <TabsPanel value="art" className="flex min-h-0 flex-1 flex-col">
        <GameLookPanel threadRef={threadRef} />
      </TabsPanel>
      <TabsPanel value="checks" className="flex min-h-0 flex-1 flex-col">
        <GameWorkbenchChecks threadRef={threadRef} />
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

/** The page's errors and warnings so far, in the colours the log gives them; nothing when none. */
function DebugCount({ threadRef }: { threadRef: ScopedThreadRef }) {
  const threadKey = scopedThreadKey(threadRef);
  const errors = useStageConsoleCount(threadKey, "error");
  const warnings = useStageConsoleCount(threadKey, "warn");
  if (errors === 0 && warnings === 0) return null;
  return (
    <span
      className="flex items-center gap-1"
      aria-label={[
        errors === 0 ? null : `${errors} ${errors === 1 ? "error" : "errors"}`,
        warnings === 0 ? null : `${warnings} ${warnings === 1 ? "warning" : "warnings"}`,
      ]
        .filter((part) => part !== null)
        .join(", ")}
    >
      {errors === 0 ? null : (
        <Text
          variant="caption"
          tone="inherit"
          numeric
          render={<span className="text-destructive-foreground" />}
        >
          {errors}
        </Text>
      )}
      {warnings === 0 ? null : (
        <Text
          variant="caption"
          tone="inherit"
          numeric
          render={<span className="text-warning-foreground" />}
        >
          {warnings}
        </Text>
      )}
    </span>
  );
}
