import { useAtomValue } from "@effect/atom-react";
import type {
  GameBuildsResult,
  GameThing,
  GameThingValue,
  ScopedThreadRef,
} from "@kurambit/contracts";
import { AsyncResult } from "effect/reactivity";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import { threadRuntimeIsActive } from "@kurambit/client-runtime/state/models";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import {
  ChevronRightIcon,
  CrosshairIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
  XIcon,
} from "lucide-react";
import { createContext, use, useEffect, useRef, useState } from "react";

import { useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { cn, randomUUID } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuerySelector } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThingLook, ThingsSection, useSelectNotice, valueLabel } from "./GameInspector";
import { GameTuneField, type TuneCommit } from "./GameTuneField";
import { Workbench } from "./GameWorkbenchParts";
import { buildName, formatBuildTime } from "./gameBuilds.logic";
import {
  clearStageSelection,
  selectStageThing,
  tuneStageValue,
  useThreadStageBridge,
} from "./gameStageBridge";

const NO_THINGS: ReadonlyArray<GameThing> = [];

/** Saves a value as it is let go; the rows reach it through context, not props. */
const TuneSave = createContext<(id: string, value: GameThingValue, how: TuneCommit) => void>(
  () => {},
);

type SaveState =
  | { readonly kind: "saved" }
  | { readonly kind: "saving" }
  /** An agent's turn is changing the game: a save then would keep its half-made work. */
  | { readonly kind: "waiting" }
  | { readonly kind: "failed"; readonly text: string };

/**
 * Saves tuned values into the game as they are let go, one at a time, each folding into the
 * session's one tuning build. While the agent's turn runs they wait (they still play), and save
 * once it ends, on top of its build. A failed save keeps its values for the next one.
 */
function useTuneSaver(threadRef: ScopedThreadRef) {
  const turnRunning = threadRuntimeIsActive(useQuietThreadShell(threadRef)?.runtime);
  const keep = useAtomCommand(gameEnvironment.keepValues, { reportFailure: false });
  const canSave = useAtomValue(gameEnvironment.keepValues.permissionAtom(threadRef.environmentId));
  const queue = useRef(new Map<string, Map<string, GameThingValue>>());
  // The last value saved per id and key: letting go where it already is saves nothing.
  const saved = useRef(new Map<string, number | boolean>());
  const busy = useRef(false);
  const [state, setState] = useState<SaveState>({ kind: "saved" });
  // One save at a time; what is let go meanwhile goes in the next, until none is left.
  const flush = useStableCallback(async () => {
    if (busy.current || !canSave) return;
    busy.current = true;
    while (queue.current.size > 0) {
      if (turnRunning) {
        setState({ kind: "waiting" });
        break;
      }
      setState({ kind: "saving" });
      const things = [...queue.current].map(([id, values]) => ({
        id,
        values: [...values.values()],
      }));
      queue.current = new Map();
      const result = await keep({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, things, commandId: randomUUID(), fold: true },
      });
      if (result._tag === "Failure") {
        // Back under anything tuned since, which is newer.
        for (const thing of things) {
          const values = queue.current.get(thing.id) ?? new Map<string, GameThingValue>();
          for (const value of thing.values)
            if (!values.has(value.key)) values.set(value.key, value);
          queue.current.set(thing.id, values);
        }
        setState({ kind: "failed", text: String(squashAtomCommandFailure(result)) });
        break;
      }
      for (const thing of things)
        for (const value of thing.values)
          saved.current.set(`${thing.id}\0${value.key}`, value.value);
      setState({ kind: "saved" });
    }
    busy.current = false;
  });
  useEffect(() => {
    if (!turnRunning) void flush();
  }, [turnRunning, flush]);
  const save = useStableCallback((id: string, value: GameThingValue, how: TuneCommit) => {
    // Let go with the pointer: the game takes the keys back, so the next press plays.
    if (how === "pointer") useGameWorkspaceStore.getState().requestStage({ kind: "focus" });
    if (saved.current.get(`${id}\0${value.key}`) === value.value && !queue.current.has(id)) return;
    const values = queue.current.get(id) ?? new Map<string, GameThingValue>();
    values.set(value.key, value);
    queue.current.set(id, values);
    void flush();
  });
  return { save, state, canSave, retry: () => void flush() };
}

/**
 * The Tune tab: every value the running game tunes (`ctx.tune`), grouped by thing, changing the
 * game as they move and saved into it as they are let go, so a Restart keeps them and Undo takes
 * the session back. The thing pointed at on the paused game comes first.
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
  const paused = useThreadStageBridge(threadKey, (state) => state.frozen, false);
  const saver = useTuneSaver(threadRef);
  const playing = status === "ready";
  const groups = things.filter(
    (thing) => (thing.values?.length ?? 0) > 0 && thing.id !== selected?.id,
  );
  const changed = [...(selected === null ? [] : [selected]), ...groups]
    .map((thing) => ({ thing, values: tunedValues(thing) }))
    .filter((thing) => thing.values.length > 0);
  const changedCount = changed.reduce((sum, thing) => sum + thing.values.length, 0);
  return (
    <TuneSave value={saver.save}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-gutter-both">
          {notice !== null || !playing ? (
            <Workbench.Empty
              icon={<SlidersHorizontalIcon />}
              title={notice?.title ?? "Waiting for the game"}
              body={notice?.body ?? "Its values show here once it answers."}
            />
          ) : (
            <>
              {selected === null ? null : (
                <PointedThing threadRef={threadRef} thing={selected} disabled={!tunable} />
              )}
              <SelectedFeel threadKey={threadKey} />
              {groups.map((thing) => (
                <TuneGroup key={thing.id} thing={thing} disabled={!tunable} />
              ))}
              {groups.length === 0 && selected === null ? (
                <Workbench.Empty
                  icon={<SlidersHorizontalIcon />}
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
          <KeptValues threadRef={threadRef} />
        </div>
        <TuneFooter
          changed={changed}
          changedCount={changedCount}
          state={saver.state}
          canSave={saver.canSave}
          onRetry={saver.retry}
        />
      </div>
    </TuneSave>
  );
}

/** Its values the person has tuned away from the game's own (tune.json holds just these). */
const tunedValues = (thing: GameThing) =>
  (thing.values ?? []).filter(
    (value) => value.default !== undefined && value.default !== value.value,
  );

/** The thing pointed at on the paused game: its values first, then where its look comes from. */
function PointedThing({
  threadRef,
  thing,
  disabled,
}: {
  threadRef: ScopedThreadRef;
  thing: GameThing;
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
        {thing.instance === undefined ? (
          <Text variant="meta" tone="strong" emphasis truncate render={<h3 />}>
            {thing.name}
          </Text>
        ) : (
          // Inside a group, as a design tool shows it: the group, then the one picked.
          <h3 className="flex min-w-0 items-center gap-1">
            <Button
              size="xs"
              variant="ghost-muted"
              className="-ms-1.5 min-w-0"
              onClick={() => selectStageThing(thing.id)}
            >
              <span className="truncate">{thing.name}</span>
            </Button>
            <ChevronRightIcon className="size-3 shrink-0 text-dim-foreground" aria-hidden="true" />
            <Text variant="meta" tone="strong" emphasis numeric>
              #{thing.instance.index + 1}
            </Text>
          </h3>
        )}
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
      {thing.instance !== undefined ? (
        <Text variant="caption" tone="muted" render={<p className="px-4 pb-2" />}>
          One of {thing.instance.count}; its values are the whole group's.
        </Text>
      ) : (thing.instances ?? 0) > 1 ? (
        <Text variant="caption" tone="muted" render={<p className="px-4 pb-2" />}>
          All {thing.instances} of them. Double-click one in the game to pick just it.
        </Text>
      ) : null}
      <TuneRows thing={thing} disabled={disabled} />
      <div className="px-4 pt-2">
        <ThingLook threadRef={threadRef} thing={thing} />
      </div>
    </section>
  );
}

/** One thing's values under a header that folds them, the way an inspector groups components. */
function TuneGroup({ thing, disabled }: { thing: GameThing; disabled: boolean }) {
  const save = use(TuneSave);
  const [open, setOpen] = useState(true);
  const tuned = tunedValues(thing);
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
          {tuned.length === 0 ? null : (
            <Text variant="caption" tone="inherit" render={<span className="text-live" />}>
              · {tuned.length} tuned
            </Text>
          )}
        </button>
        {tuned.length === 0 ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Put ${thing.name}'s values back to the game's own`}
                  onClick={() => {
                    for (const value of tuned) putBack(thing, value, save);
                  }}
                />
              }
            >
              <RotateCcwIcon aria-hidden="true" />
            </TooltipTrigger>
            <TooltipPopup side="left">
              Put {thing.name}'s values back to the game's own
            </TooltipPopup>
          </Tooltip>
        )}
      </div>
      {open ? (
        <div className="pb-2">
          <TuneRows thing={thing} disabled={disabled} />
        </div>
      ) : null}
    </section>
  );
}

/** One value back at the game's own: it plays, and saving it takes it out of the tune file. */
const putBack = (
  thing: GameThing,
  value: GameThingValue,
  save: (id: string, value: GameThingValue, how: TuneCommit) => void,
) => {
  if (value.default === undefined) return;
  tuneStageValue(thing.id, value.key, value.default);
  save(thing.id, { ...value, value: value.default }, "keyboard");
};

function TuneRows({ thing, disabled }: { thing: GameThing; disabled: boolean }) {
  const save = use(TuneSave);
  return (
    <div className="flex flex-col">
      {(thing.values ?? []).map((value) => {
        const tuned = value.default !== undefined && value.default !== value.value;
        return (
          <GameTuneField
            key={value.key}
            label={valueLabel(value)}
            value={value}
            was={tuned ? value.default : undefined}
            disabled={disabled}
            onChange={(next) => tuneStageValue(thing.id, value.key, next)}
            onCommit={(next, how) => save(thing.id, { ...value, value: next }, how)}
            onReset={tuned ? () => putBack(thing, value, save) : undefined}
          />
        );
      })}
    </div>
  );
}

/**
 * Only while something is tuned: how many values differ from the game's own, whether they are
 * saved, and putting them all back. Undo in the top bar takes a session of tuning back too.
 */
function TuneFooter({
  changed,
  changedCount,
  state,
  canSave,
  onRetry,
}: {
  changed: ReadonlyArray<{
    readonly thing: GameThing;
    readonly values: ReadonlyArray<GameThingValue>;
  }>;
  changedCount: number;
  state: SaveState;
  canSave: boolean;
  onRetry: () => void;
}) {
  const save = use(TuneSave);
  if (changedCount === 0 && state.kind !== "failed") return null;
  const said = !canSave
    ? "Playing, not saved: this connection cannot change the game"
    : state.kind === "saving"
      ? "Saving…"
      : state.kind === "waiting"
        ? "Saves when the agent's turn ends"
        : state.kind === "failed"
          ? state.text
          : "Saved in the game";
  return (
    <div className="flex shrink-0 flex-col gap-1 border-t border-border bg-background px-4 py-3">
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-live" />
        <Text variant="meta" tone="default" render={<span className="min-w-0 flex-1" />}>
          {changedCount === 1 ? "1 value tuned" : `${changedCount} values tuned`}
        </Text>
        {state.kind === "failed" ? (
          <Button size="sm" variant="ghost" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            for (const { thing, values } of changed)
              for (const value of values) putBack(thing, value, save);
          }}
        >
          Put all back
        </Button>
      </div>
      <Text
        variant="caption"
        tone={state.kind === "failed" ? "destructive" : "muted"}
        render={<p role={state.kind === "failed" ? "alert" : "status"} />}
      >
        {said}
      </Text>
    </div>
  );
}

const FEEL_W = 240;
const FEEL_H = 36;

/**
 * The pointed thing's ground speed over its last seconds, and its last jump in numbers: what a
 * tuned speed or jump did, without a stopwatch. Drawn only when the game sends a new trace.
 */
function SelectedFeel({ threadKey }: { threadKey: string }) {
  const selected = useThreadStageBridge(threadKey, (state) => state.selected, null);
  const feel = selected?.trace?.feel;
  if (selected === null || feel === undefined) return null;
  const top = Math.max(feel.top, 0.1);
  const step = feel.speeds.length > 1 ? FEEL_W / (feel.speeds.length - 1) : 0;
  const line = feel.speeds
    .map(
      (speed, i) =>
        `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)} ${(FEEL_H - (Math.min(speed, top) / top) * FEEL_H).toFixed(1)}`,
    )
    .join(" ");
  const jump = feel.jumps.at(-1);
  return (
    <Workbench.Section
      title="Feel"
      detail={`${selected.thing.name}'s ground speed over its last seconds`}
      aside={
        <Text variant="caption" tone="muted" numeric>
          top {feel.top.toFixed(1)} m/s
        </Text>
      }
      className="border-b border-border"
    >
      <svg
        viewBox={`0 0 ${FEEL_W} ${FEEL_H}`}
        preserveAspectRatio="none"
        className="h-9 w-full overflow-visible"
        aria-hidden="true"
      >
        <path
          d={line}
          fill="none"
          className="stroke-primary"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {jump === undefined ? null : (
        <Text variant="meta" tone="muted" numeric render={<p />}>
          Last jump {jump.height.toFixed(2)} m high, {jump.seconds.toFixed(2)} s in the air,{" "}
          {jump.distance.toFixed(1)} m long
        </Text>
      )}
    </Workbench.Section>
  );
}

/** Builds that kept values from the Stage, newest first: each tuning session is one. */
const keptValuesBuilds = (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) =>
  AsyncResult.isSuccess(result)
    ? result.value.builds.filter(
        (build) => build.source._tag === "saved" && build.source.edit === "values",
      )
    : null;

/** The values kept as builds and when: a tuning session is one build, which Undo takes back. */
function KeptValues({ threadRef }: { threadRef: ScopedThreadRef }) {
  const kept = useEnvironmentQuerySelector(
    gameEnvironment.builds({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
    keptValuesBuilds,
  );
  if (kept == null || kept.length === 0) return null;
  return (
    <Workbench.Section
      title="Kept as builds"
      detail="Each tuning session saves as one build: Undo takes it back."
    >
      <ul className="flex flex-col gap-1">
        {kept.slice(0, 12).map((build) => (
          <li key={build.id} className="flex min-w-0 flex-col">
            <span className="flex items-baseline gap-2">
              <Text variant="meta" tone="default" truncate render={<span className="flex-1" />}>
                {buildName(build)}
              </Text>
              <Text variant="caption" tone="muted" numeric>
                {formatBuildTime(build.at)}
              </Text>
            </span>
            <Text variant="caption" tone="muted" render={<span className="break-words" />}>
              {build.summary}
            </Text>
          </li>
        ))}
      </ul>
    </Workbench.Section>
  );
}
