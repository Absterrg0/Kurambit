import type { ScopedThreadRef } from "@kurambit/contracts";
import {
  ActivityIcon,
  ClipboardCheckIcon,
  HistoryIcon,
  NotebookPenIcon,
  PaletteIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { useGameWorkspaceStore, type WorkbenchTab, WORKBENCH_TABS } from "../../gameWorkspaceStore";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../ui/tabs";
import { GameDecisionsPanel } from "./GameDecisions";
import { GameBuildDetail, GameLookPanel } from "./GameInspector";
import { GameTunePanel } from "./GameTune";
import { GameWorkbenchHistory } from "./GameWorkbenchHistory";
import { GameWorkbenchRun } from "./GameWorkbenchRun";

const TAB: Record<WorkbenchTab, { readonly label: string; readonly icon: ReactNode }> = {
  run: { label: "Run", icon: <ActivityIcon aria-hidden="true" /> },
  tune: { label: "Tune", icon: <SlidersHorizontalIcon aria-hidden="true" /> },
  art: { label: "Art", icon: <PaletteIcon aria-hidden="true" /> },
  checks: { label: "Checks", icon: <ClipboardCheckIcon aria-hidden="true" /> },
  history: { label: "History", icon: <HistoryIcon aria-hidden="true" /> },
  decisions: { label: "Decisions", icon: <NotebookPenIcon aria-hidden="true" /> },
};

const isTab = (value: unknown): value is WorkbenchTab =>
  (WORKBENCH_TABS as ReadonlyArray<unknown>).includes(value);

/**
 * The game's Workbench, beside the Stage: the run being played, its values, its art, the build's
 * checks, its history and the decisions every session reads. Only the open tab is mounted, so a
 * tab out of sight costs nothing.
 */
export function GameWorkbench({
  threadRef,
  onAsk,
}: {
  threadRef: ScopedThreadRef;
  onAsk: (text: string) => void;
}) {
  const tab = useGameWorkspaceStore((state) => state.workbenchTab);
  const setTab = useGameWorkspaceStore((state) => state.setWorkbenchTab);
  return (
    <Tabs
      value={tab}
      onValueChange={(next) => {
        if (isTab(next)) setTab(next);
      }}
      className="@container/workbench flex min-h-0 flex-1 flex-col"
    >
      <div className="shrink-0 border-b border-border px-2 py-2">
        <TabsList aria-label="Workbench" className="w-full">
          {WORKBENCH_TABS.map((value) => (
            // Names always; their icons join once the panel has the room. Each takes its name's
            // width, so the longest ("Decisions") fits a narrow panel whole.
            <TabsTab key={value} value={value} className="flex-auto">
              <span className="hidden @[34rem]/workbench:contents">{TAB[value].icon}</span>
              {TAB[value].label}
            </TabsTab>
          ))}
        </TabsList>
      </div>
      <TabsPanel value="run" className="flex min-h-0 flex-1 flex-col">
        <GameWorkbenchRun threadRef={threadRef} />
      </TabsPanel>
      <TabsPanel value="tune" className="flex min-h-0 flex-1 flex-col">
        <GameTunePanel threadRef={threadRef} onAsk={onAsk} />
      </TabsPanel>
      {/* The game's look, characters and generated art, as the Look panel had them. */}
      <TabsPanel value="art" className="flex min-h-0 flex-1 flex-col">
        <GameLookPanel threadRef={threadRef} />
      </TabsPanel>
      <TabsPanel value="checks" className="flex min-h-0 flex-1 flex-col">
        <GameBuildDetail threadRef={threadRef} />
      </TabsPanel>
      <TabsPanel value="history" className="flex min-h-0 flex-1 flex-col">
        <GameWorkbenchHistory threadRef={threadRef} />
      </TabsPanel>
      <TabsPanel value="decisions" className="flex min-h-0 flex-1 flex-col">
        <GameDecisionsPanel threadRef={threadRef} />
      </TabsPanel>
    </Tabs>
  );
}
