import { useAtomValue } from "@effect/atom-react";
import type { GameThing, ScopedThreadRef } from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import { ChevronRightIcon, CrosshairIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { cn, randomUUID } from "../../lib/utils";
import { gameEnvironment } from "../../state/game";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThingLook, ThingsSection, useSelectNotice, valueLabel } from "./GameInspector";
import { GameTuneField } from "./GameTuneField";
import {
  clearStageSelection,
  forgetStageTuning,
  resetStageValues,
  tuneStageValue,
  useThreadStageBridge,
} from "./gameStageBridge";

const NO_THINGS: ReadonlyArray<GameThing> = [];
const NO_TUNING: Readonly<Record<string, Readonly<Record<string, number | boolean>>>> = {};
/** How long "Kept as build 4" stays in the footer before it folds away. */
const SAID_MS = 6000;

/**
 * The Tune tab: every value the running game tunes (`ctx.tune`), grouped by thing, changing the
 * game as they move. The thing pointed at on the paused game comes first. A footer appears only
 * while something is changed: keep the changes as a build, or put them back.
 */
export function GameTunePanel({
  threadRef,
  onAsk,
}: {
  threadRef: ScopedThreadRef;
  onAsk: (text: string) => void;
}) {
  const threadKey = scopedThreadKey(threadRef);
  const notice = useSelectNotice(threadRef);
  const status = useThreadStageBridge(threadKey, (state) => state.status, null);
  const tunable = useThreadStageBridge(
    threadKey,
    (state) => state.capabilities.includes("tune"),
    false,
  );
  const things = useThreadStageBridge(threadKey, (state) => state.things, NO_THINGS);
  const selected = useThreadStageBridge(threadKey, (state) => state.selected?.thing ?? null, null);
  const tunedFrom = useThreadStageBridge(threadKey, (state) => state.tunedFrom, NO_TUNING);
  const paused = useThreadStageBridge(threadKey, (state) => state.frozen, false);
  const playing = status === "ready";
  const groups = things.filter(
    (thing) => (thing.values?.length ?? 0) > 0 && thing.id !== selected?.id,
  );
  const changed = [...(selected === null ? [] : [selected]), ...groups]
    .map((thing) => ({ id: thing.id, values: changedValues(thing, tunedFrom[thing.id]) }))
    .filter((thing) => thing.values.length > 0);
  const changedCount = changed.reduce((sum, thing) => sum + thing.values.length, 0);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-gutter-both">
        {notice !== null ? (
          <TuneNote title={notice.title} body={notice.body} />
        ) : !playing ? (
          <TuneNote
            title="Play the game to tune it"
            body="Its speeds, jump height, timers and counts show here while it runs."
          />
        ) : (
          <>
            {selected === null ? null : (
              <PointedThing
                threadRef={threadRef}
                thing={selected}
                tunedFrom={tunedFrom[selected.id]}
                disabled={!tunable}
              />
            )}
            {groups.map((thing) => (
              <TuneGroup
                key={thing.id}
                thing={thing}
                tunedFrom={tunedFrom[thing.id]}
                disabled={!tunable}
              />
            ))}
            {groups.length === 0 && selected === null ? (
              <TuneNote
                title="Nothing to tune on this screen"
                body="Values show here once play starts. If none do, your agent can expose them."
                action={
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      onAsk(
                        "Make this game's key numbers tunable from the Stage: the player's speed and jump height, enemy speeds and counts, timers and the win and lose targets.",
                      )
                    }
                  >
                    Ask your agent to expose them
                  </Button>
                }
              />
            ) : null}
            {/* Paused, everything on screen can be pointed at, tunable or not. */}
            {paused ? (
              <div className="px-4 py-4">
                <ThingsSection threadRef={threadRef} />
              </div>
            ) : null}
          </>
        )}
      </div>
      <TuneFooter threadRef={threadRef} changed={changed} changedCount={changedCount} />
    </div>
  );
}

const changedValues = (
  thing: GameThing,
  before: Readonly<Record<string, number | boolean>> | undefined,
) =>
  (thing.values ?? []).filter(
    (value) => before !== undefined && value.key in before && before[value.key] !== value.value,
  );

/** A short line where values would be, with what to do next. */
function TuneNote({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-1 px-4 py-5">
      <Text variant="meta" tone="strong" emphasis render={<p />}>
        {title}
      </Text>
      <Text variant="meta" tone="muted" render={<p />}>
        {body}
      </Text>
      {action === undefined ? null : <div className="mt-2">{action}</div>}
    </div>
  );
}

/** The thing pointed at on the paused game: its values first, then where its look comes from. */
function PointedThing({
  threadRef,
  thing,
  tunedFrom,
  disabled,
}: {
  threadRef: ScopedThreadRef;
  thing: GameThing;
  tunedFrom: Readonly<Record<string, number | boolean>> | undefined;
  disabled: boolean;
}) {
  return (
    <section
      tabIndex={-1}
      aria-label={`${thing.name}, pointed at`}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.target instanceof HTMLInputElement) return;
        event.preventDefault();
        clearStageSelection();
      }}
      className="border-b border-border bg-accent/40 pb-2 outline-none"
    >
      <div className="flex h-10 items-center gap-2 ps-4 pe-2">
        <CrosshairIcon className="size-3.5 shrink-0 text-live" aria-hidden="true" />
        <Text variant="meta" tone="strong" emphasis truncate render={<h3 />}>
          {thing.name}
        </Text>
        <Text variant="caption" tone="muted">
          {thing.kind}
        </Text>
        <span className="flex-1" />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Stop pointing at it"
                onClick={clearStageSelection}
              />
            }
          >
            <XIcon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup side="left">Stop pointing at it (Esc)</TooltipPopup>
        </Tooltip>
      </div>
      <Text variant="caption" tone="muted" render={<p className="px-4 pb-2" />}>
        Your next message takes it, with this frame and its values.
      </Text>
      <TuneRows thing={thing} tunedFrom={tunedFrom} disabled={disabled} />
      <div className="px-4 pt-2">
        <ThingLook threadRef={threadRef} thing={thing} />
      </div>
    </section>
  );
}

/** One thing's values under a header that folds them, the way an inspector groups components. */
function TuneGroup({
  thing,
  tunedFrom,
  disabled,
}: {
  thing: GameThing;
  tunedFrom: Readonly<Record<string, number | boolean>> | undefined;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(true);
  const changed = changedValues(thing, tunedFrom).length;
  return (
    <section className="border-b border-border">
      <div className="group/tune-head flex h-9 items-center gap-1 ps-2 pe-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground motion-popup transition-transform",
              open && "rotate-90",
            )}
            aria-hidden="true"
          />
          <Text variant="meta" tone="strong" emphasis truncate>
            {thing.name}
          </Text>
          <Text variant="caption" tone="muted">
            {thing.kind}
          </Text>
          {changed === 0 ? null : (
            <Text variant="caption" tone="inherit" render={<span className="text-live" />}>
              · {changed} changed
            </Text>
          )}
        </button>
        {changed === 0 ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Put ${thing.name}'s values back`}
                  onClick={() => resetStageValues(thing.id)}
                />
              }
            >
              <RotateCcwIcon aria-hidden="true" />
            </TooltipTrigger>
            <TooltipPopup side="left">Put {thing.name}'s values back</TooltipPopup>
          </Tooltip>
        )}
      </div>
      {open ? (
        <div className="pb-2">
          <TuneRows thing={thing} tunedFrom={tunedFrom} disabled={disabled} />
        </div>
      ) : null}
    </section>
  );
}

function TuneRows({
  thing,
  tunedFrom,
  disabled,
}: {
  thing: GameThing;
  tunedFrom: Readonly<Record<string, number | boolean>> | undefined;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col">
      {(thing.values ?? []).map((value) => {
        const was = tunedFrom?.[value.key];
        const edited = was !== undefined && was !== value.value;
        return (
          <GameTuneField
            key={value.key}
            label={valueLabel(value)}
            value={value}
            was={edited ? was : undefined}
            disabled={disabled}
            onChange={(next) => tuneStageValue(thing.id, value.key, next, value.value)}
            onReset={
              edited ? () => tuneStageValue(thing.id, value.key, was, value.value) : undefined
            }
          />
        );
      })}
    </div>
  );
}

/**
 * Only while something is changed: how many values play changed, Reset, and Keep as a build.
 * After a keep, what it made stays a moment, then the footer folds away.
 */
function TuneFooter({
  threadRef,
  changed,
  changedCount,
}: {
  threadRef: ScopedThreadRef;
  changed: ReadonlyArray<{ readonly id: string; readonly values: GameThing["values"] }>;
  changedCount: number;
}) {
  const canKeep = useAtomValue(gameEnvironment.keepValues.permissionAtom(threadRef.environmentId));
  const keep = useAtomCommand(gameEnvironment.keepValues, { reportFailure: false });
  const [keeping, setKeeping] = useState(false);
  const [said, setSaid] = useState<{ readonly text: string; readonly failed: boolean } | null>(
    null,
  );
  useEffect(() => {
    if (said === null || said.failed) return;
    const timer = window.setTimeout(() => setSaid(null), SAID_MS);
    return () => window.clearTimeout(timer);
  }, [said]);
  if (changedCount === 0 && said === null) return null;
  const keepAll = async () => {
    setKeeping(true);
    setSaid(null);
    const result = await keep({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        things: changed.map((thing) => ({ id: thing.id, values: thing.values ?? [] })),
        commandId: randomUUID(),
      },
    });
    setKeeping(false);
    if (result._tag === "Failure")
      setSaid({ text: String(squashAtomCommandFailure(result)), failed: true });
    else {
      for (const thing of changed) forgetStageTuning(thing.id);
      setSaid({ text: result.value.message, failed: false });
    }
  };
  return (
    <div className="flex shrink-0 flex-col gap-1 border-t border-border bg-background px-4 py-3">
      {changedCount === 0 ? null : (
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-live" />
          <Text variant="meta" tone="default" render={<span className="min-w-0 flex-1" />}>
            {changedCount === 1 ? "1 change playing" : `${changedCount} changes playing`}
          </Text>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              for (const thing of changed) resetStageValues(thing.id);
            }}
          >
            Reset
          </Button>
          <Button size="sm" disabled={keeping || !canKeep} onClick={() => void keepAll()}>
            {keeping ? "Keeping…" : "Keep as a build"}
          </Button>
        </div>
      )}
      {said === null ? null : (
        <Text
          variant="caption"
          tone={said.failed ? "destructive" : "muted"}
          render={<p role={said.failed ? "alert" : "status"} />}
        >
          {said.text}
        </Text>
      )}
    </div>
  );
}
