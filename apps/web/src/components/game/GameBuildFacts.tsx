import { FileVideoIcon, ImageIcon, ScrollTextIcon } from "lucide-react";
import {
  gameFactsView,
  type GameBuildFacts,
  type GameBuildFactsSummary,
  type GameCharacterRoute,
  type GameFactDelta,
  type GameFactTone,
  type ScopedThreadRef,
} from "@kurambit/contracts";

import { cn } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { characterRouteLabel } from "./GameCharacterRoute";
import { assetLines, deltaLine, factLine, factsSummaryLine } from "./gameBuilds.logic";

const TONE_TEXT: Record<GameFactTone, string> = {
  good: "text-success-foreground",
  bad: "text-destructive-foreground",
  neutral: "text-foreground",
};
const CHIP: Record<GameFactTone, "success" | "error" | "outline"> = {
  good: "success",
  bad: "error",
  neutral: "outline",
};

/** A rail row's facts: the server's chips, or what state the facts are in. */
export function GameBuildFactChips({ summary }: { summary: GameBuildFactsSummary }) {
  const line = factsSummaryLine(summary);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {summary.chips.map((chip) => (
        <Badge key={chip.id} size="sm" variant={CHIP[chip.tone]}>
          {chip.text}
        </Badge>
      ))}
      {line === null ? null : <span className="text-2xs text-muted-foreground">{line}</span>}
    </span>
  );
}

const EVIDENCE_ICON = { video: FileVideoIcon, frame: ImageIcon, log: ScrollTextIcon } as const;

/** One build's facts, as the shared view words them; evidence opens in the file preview. */
export function GameBuildFactsList({
  threadRef,
  facts,
  characters,
}: {
  threadRef: ScopedThreadRef;
  facts: GameBuildFacts;
  /** The game's setting now, not this build's: shown with the Assets row. */
  characters: GameCharacterRoute | null;
}) {
  const views = gameFactsView(facts);
  return (
    <div className="space-y-2">
      {facts.message ? <p className="text-2xs text-muted-foreground">{facts.message}</p> : null}
      {views.length > 0 ? (
        <dl className="divide-y divide-border rounded-lg border border-border">
          {views.map((view) => {
            const line = factLine(view);
            return (
              <div
                key={view.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2"
              >
                <dt className="w-36 shrink-0 text-xs text-muted-foreground">{line.label}</dt>
                <dd
                  className={cn(
                    "min-w-0 flex-1 text-xs",
                    line.tone === null ? "text-muted-foreground" : TONE_TEXT[line.tone],
                  )}
                >
                  {line.text}
                </dd>
                {view.id === "assets" ? (
                  <dd className="w-full text-2xs text-muted-foreground">
                    <ul className="space-y-0.5 break-words">
                      {facts.assets.status === "measured"
                        ? assetLines(facts.assets.value).map((text) => <li key={text}>{text}</li>)
                        : null}
                      {characters === null ? null : (
                        <li>
                          This game makes characters with {characterRouteLabel(characters)}; change
                          it under More, Make characters with….
                        </li>
                      )}
                    </ul>
                  </dd>
                ) : null}
                {view.evidence.length > 0 ? (
                  <dd className="flex shrink-0 flex-wrap gap-1">
                    {view.evidence.map((item) => {
                      const Icon = EVIDENCE_ICON[item.kind];
                      return (
                        <Button
                          key={item.path}
                          size="xs"
                          variant="ghost"
                          onClick={() =>
                            useRightPanelStore.getState().openFile(threadRef, item.path)
                          }
                        >
                          <Icon aria-hidden="true" />
                          {item.label}
                        </Button>
                      );
                    })}
                  </dd>
                ) : null}
              </div>
            );
          })}
        </dl>
      ) : null}
      {facts.renderer ? (
        <p className="text-2xs text-muted-foreground">Played with {facts.renderer}.</p>
      ) : null}
    </div>
  );
}

const DELTA_TEXT = {
  better: "text-success-foreground",
  worse: "text-destructive-foreground",
  neutral: "text-muted-foreground",
} as const;

/** Two builds' facts side by side, with the shared diff's direction and tone. */
export function GameBuildFactsDiff({
  deltas,
  labels,
}: {
  deltas: ReadonlyArray<GameFactDelta>;
  labels: readonly [string, string];
}) {
  if (deltas.length === 0) return null;
  return (
    <table className="w-full table-fixed border-collapse text-xs">
      <thead>
        <tr className="text-left text-2xs text-muted-foreground">
          <th className="w-1/4 py-1 pr-2 font-normal">Fact</th>
          <th className="py-1 pr-2 font-normal">{labels[0]}</th>
          <th className="py-1 pr-2 font-normal">{labels[1]}</th>
          <th className="w-8 py-1 font-normal" aria-label="Change" />
        </tr>
      </thead>
      <tbody>
        {deltas.map((delta) => {
          const line = deltaLine(delta);
          return (
            <tr key={delta.id} className="border-t border-border align-baseline">
              <td className="py-1.5 pr-2 text-muted-foreground">{line.label}</td>
              {line.why === null ? (
                <>
                  <td className="py-1.5 pr-2">{line.a}</td>
                  <td className="py-1.5 pr-2">{line.b}</td>
                </>
              ) : (
                <td colSpan={2} className="py-1.5 pr-2 text-muted-foreground">
                  {line.why}
                </td>
              )}
              <td
                className={cn(
                  "py-1.5 text-center font-medium",
                  line.tone === null ? "text-muted-foreground" : DELTA_TEXT[line.tone],
                )}
              >
                {line.mark ?? ""}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
