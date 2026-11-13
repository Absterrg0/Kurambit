import type { GameBuildsResult, ScopedThreadRef } from "@kurambit/contracts";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  FilmIcon,
  ListChecksIcon,
  MessageSquareIcon,
} from "lucide-react";
import { AsyncResult } from "effect/reactivity";

import { type GameDockTab, useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { cn } from "../../lib/utils";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuerySelector } from "../../state/query";
import { Button } from "../ui/button";
import { Tabs, TabsList, TabsTab } from "../ui/tabs";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { GameBuildDetail } from "./GameInspector";

/** The lead checks of the folder's build, as marks: passed, failed, or not read yet. */
export interface StageChecks {
  readonly marks: ReadonlyArray<"pass" | "fail" | "none">;
  readonly pass: number;
  readonly of: number;
}

const stageChecksOf = (
  result: AsyncResult.AsyncResult<GameBuildsResult, unknown>,
): StageChecks | null => {
  if (!AsyncResult.isSuccess(result)) return null;
  const build = result.value.builds.find((each) => each.id === result.value.current);
  const lead = build?.facts.lead;
  if (lead === undefined) return null;
  const measured = lead.measured ?? [];
  const passing = new Set(lead.passing ?? []);
  const marks = Array.from({ length: lead.of }, (_, index): StageChecks["marks"][number] => {
    const id = measured[index];
    return id === undefined ? "none" : passing.has(id) ? "pass" : "fail";
  });
  return { marks, pass: lead.pass, of: lead.of };
};

export const useStageChecks = (threadRef: ScopedThreadRef) =>
  useEnvironmentQuerySelector(
    gameEnvironment.builds({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
    stageChecksOf,
  ) ?? null;

/** One small square per lead check, coloured by how it read. */
export function CheckMarks({ checks }: { checks: StageChecks }) {
  return (
    <span aria-hidden className="inline-flex gap-0.5">
      {checks.marks.map((mark, index) => (
        <span
          // The marks are positional: the lead checks in their fixed order.
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          className={cn(
            "size-1.5 rounded-xs",
            mark === "pass"
              ? "bg-success"
              : mark === "fail"
                ? "bg-destructive"
                : "bg-dim-foreground/40",
          )}
        />
      ))}
    </span>
  );
}

const DOCK_TABS: ReadonlyArray<{
  readonly tab: GameDockTab;
  readonly label: string;
  readonly Icon: typeof MessageSquareIcon;
}> = [
  { tab: "agent", label: "Agent", Icon: MessageSquareIcon },
  { tab: "checks", label: "Checks", Icon: ListChecksIcon },
  { tab: "recordings", label: "Recordings", Icon: FilmIcon },
];

/**
 * The dock's bar under the game: Agent (the chat and its composer), Checks (the build's checks
 * beside what changed) and Recordings (the bot's plays), and the fold that gives the game the
 * column. Its tabs unfold it.
 */
export function GameDockBar({ threadRef }: { threadRef: ScopedThreadRef }) {
  const tab = useGameWorkspaceStore((state) => state.dockTab);
  const collapsed = useGameWorkspaceStore((state) => state.dockCollapsed);
  const showTab = useGameWorkspaceStore((state) => state.showDockTab);
  const setCollapsed = useGameWorkspaceStore((state) => state.setDockCollapsed);
  const checks = useStageChecks(threadRef);
  return (
    <div
      data-game-dock-bar=""
      className="flex h-10 shrink-0 items-center gap-2 border-t border-border bg-background px-2"
    >
      <Tabs value={collapsed ? null : tab} onValueChange={(next: GameDockTab) => showTab(next)}>
        <TabsList aria-label="Dock">
          {DOCK_TABS.map(({ tab: value, label, Icon }) => (
            <TabsTab key={value} value={value} className="flex-none">
              <Icon className="size-3.5" aria-hidden="true" />
              {label}
              {value === "checks" && checks !== null && checks.of > 0 ? (
                <Text
                  variant="caption"
                  tone="muted"
                  numeric
                  render={<span className="flex items-center gap-1.5" />}
                >
                  <CheckMarks checks={checks} />
                  {checks.pass}/{checks.of}
                </Text>
              ) : null}
            </TabsTab>
          ))}
        </TabsList>
      </Tabs>
      <span className="flex-1" />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={collapsed ? "Show the dock" : "Fold the dock away"}
              onClick={() => setCollapsed(!collapsed)}
            />
          }
        >
          {collapsed ? (
            <ChevronUpIcon className="size-4" aria-hidden="true" />
          ) : (
            <ChevronDownIcon className="size-4" aria-hidden="true" />
          )}
        </TooltipTrigger>
        <TooltipPopup side="top">{collapsed ? "Show the dock" : "Fold the dock away"}</TooltipPopup>
      </Tooltip>
    </div>
  );
}

/** The dock's Checks or Recordings tab; the Agent tab is the chat itself. */
export function GameDockPanel({
  threadRef,
  tab,
}: {
  threadRef: ScopedThreadRef;
  tab: "checks" | "recordings";
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
      <GameBuildDetail threadRef={threadRef} part={tab} />
    </div>
  );
}
