import { useAtomValue } from "@effect/atom-react";
import type { GameThing, GameThingValue, ScopedThreadRef } from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import { threadRuntimeIsActive } from "@kurambit/client-runtime/state/models";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import {
  ChevronRightIcon,
  CrosshairIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { createContext, use, useEffect, useRef, useState } from "react";

import { useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { cn, randomUUID } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { gameEnvironment } from "../../state/game";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useSelectNotice, valueLabel } from "./GameInspector";
import { GameThingPicture, KIND_ICON, useStageBuild } from "./GameThingPicture";
import { GameTuneField, type TuneCommit } from "./GameTuneField";
import { Workbench } from "./GameWorkbenchParts";
import {
  hoverStageThing,
  pointAtStageThing,
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
  | { readonly kind: "idle" }
  | { readonly kind: "saved" }
  | { readonly kind: "saving" }
  /** An agent's turn is changing the game: a save then would keep its half-made work. */
  | { readonly kind: "waiting" }
  /** The session was kept as a build: the next value let go starts another. */
  | { readonly kind: "kept" }
  | { readonly kind: "failed"; readonly text: string };

/**
 * Saves tuned values into the game as they are let go, one at a time, each folding into the
 * session's one tuning build, so a Restart keeps them and one Undo takes the session back. Keep
 * as a build ends the session: what is let go after it folds into a new build. While the agent's
 * turn runs, values wait (they still play) and save once it ends, on top of its build. A failed
 * save keeps its values for the next one.
 */
export function useTuneSaver(threadRef: ScopedThreadRef) {
  const turnRunning = threadRuntimeIsActive(useQuietThreadShell(threadRef)?.runtime);
  const keep = useAtomCommand(gameEnvironment.keepValues, { reportFailure: false });
  const canSave = useAtomValue(gameEnvironment.keepValues.permissionAtom(threadRef.environmentId));
  const queue = useRef(new Map<string, Map<string, GameThingValue>>());
  // The last value saved per id and key: letting go where it already is saves nothing.
  const saved = useRef(new Map<string, number | boolean>());
  // The next save starts a build of its own rather than fold into the session's.
  const fresh = useRef(false);
  const busy = useRef(false);
  const [state, setState] = useState<SaveState>({ kind: "idle" });
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
      const fold = !fresh.current;
      fresh.current = false;
      const result = await keep({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, things, commandId: randomUUID(), fold },
      });
      if (result._tag === "Failure") {
        // Back under anything tuned since, which is newer.
        for (const thing of things) {
          const values = queue.current.get(thing.id) ?? new Map<string, GameThingValue>();
          for (const value of thing.values)
            if (!values.has(value.key)) values.set(value.key, value);
          queue.current.set(thing.id, values);
        }
        fresh.current = !fold;
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
  const keepAsBuild = () => {
    fresh.current = true;
    setState({ kind: "kept" });
  };
  return { save, state, canSave, keepAsBuild, retry: () => void flush() };
}

/** Its values the person has tuned away from the game's own (tune.json holds just these). */
const tunedValues = (thing: GameThing) =>
  (thing.values ?? []).filter(
    (value) => value.default !== undefined && value.default !== value.value,
  );

/** The kinds as the Things list groups them; a thing of kind "other" stands under its own name. */
const KIND_GROUPS: ReadonlyArray<{ readonly kind: GameThing["kind"]; readonly label: string }> = [
  { kind: "character", label: "Characters" },
  { kind: "creature", label: "Creatures" },
  { kind: "prop", label: "Props" },
  { kind: "level", label: "Level" },
  { kind: "effect", label: "Effects" },
  { kind: "ui", label: "Interface" },
  { kind: "rule", label: "Rules" },
  { kind: "sound", label: "Sound" },
];

/** A thing's kind as its name tag on the Stage says it. */
export const KIND_WORDS: Record<GameThing["kind"], string> = {
  character: "character",
  creature: "creature",
  prop: "prop",
  level: "level",
  effect: "effect",
  ui: "interface",
  rule: "rule",
  sound: "sound",
  other: "thing",
};

const hasValues = (thing: GameThing) => (thing.values?.length ?? 0) > 0;

/**
 * Tune, as an engine's inspector: the things the game named with values to tune, by kind, over
 * the picked thing's values. Values change the game as they move and save into it as they are
 * let go. Pointing at a thing on the paused Stage picks it here.
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
  const all = useThreadStageBridge(threadKey, (state) => state.things, NO_THINGS);
  const pointed = useThreadStageBridge(threadKey, (state) => state.selected?.thing ?? null, null);
  const build = useStageBuild(threadRef);
  const saver = useTuneSaver(threadRef);
  const [picked, setPicked] = useState<string | null>(null);
  // A thing pointed at on the Stage is the one picked here, until another is.
  const [followed, setFollowed] = useState<string | null>(null);
  if ((pointed?.id ?? null) !== followed) {
    setFollowed(pointed?.id ?? null);
    if (pointed !== null && hasValues(pointed)) setPicked(pointed.id);
  }
  const things = all.filter(hasValues);
  const changed = things
    .map((thing) => ({ thing, values: tunedValues(thing) }))
    .filter((entry) => entry.values.length > 0);
  const changedCount = changed.reduce((sum, entry) => sum + entry.values.length, 0);
  if (notice !== null || status !== "ready")
    return (
      <Workbench.Empty
        icon={<SlidersHorizontalIcon />}
        title={notice?.title ?? "Waiting for the game"}
        body={notice?.body}
      />
    );
  if (things.length === 0)
    return (
      <Workbench.Empty
        icon={<SlidersHorizontalIcon />}
        title="Nothing to tune"
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
            Ask your agent to expose values
          </Button>
        }
      />
    );
  // The pointed thing as the game reports it, else the listed one picked, else the first.
  const shown =
    (pointed !== null && pointed.id === picked && hasValues(pointed) ? pointed : null) ??
    things.find((thing) => thing.id === picked) ??
    things[0] ??
    null;
  return (
    <TuneSave value={saver.save}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="max-h-[45%] shrink-0 overflow-y-auto border-b border-border py-2">
          <ThingList
            threadRef={threadRef}
            build={build}
            things={things}
            picked={shown?.id ?? null}
            onPick={(id) => {
              setPicked(id);
              // The Stage points at it too: the outline and Tune always name the same thing.
              selectStageThing(id);
            }}
          />
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {shown === null ? null : (
            <ThingInspector threadRef={threadRef} build={build} thing={shown} disabled={!tunable} />
          )}
        </div>
        <TuneFooter
          changed={changed}
          changedCount={changedCount}
          state={saver.state}
          canSave={saver.canSave}
          onKeep={saver.keepAsBuild}
          onRetry={saver.retry}
        />
      </div>
    </TuneSave>
  );
}

/**
 * The things with values, by kind, as an outliner lists a scene: each kind a group that folds,
 * with its glyph and count; a row each, with its picture, its value count and a live dot when
 * tuned, the picked one on the selection background. Hovering a row outlines it on a frozen Stage.
 */
function ThingList({
  threadRef,
  build,
  things,
  picked,
  onPick,
}: {
  threadRef: ScopedThreadRef;
  build: string | null;
  things: ReadonlyArray<GameThing>;
  picked: string | null;
  onPick: (id: string) => void;
}) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const row = (thing: GameThing) => (
    <div key={thing.id} className="px-2">
      <button
        type="button"
        role="option"
        aria-selected={picked === thing.id}
        onClick={() => onPick(thing.id)}
        onPointerEnter={() => hoverStageThing(thing.id)}
        onPointerLeave={() => hoverStageThing(null)}
        className={cn(
          "flex h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md ps-6 pe-2 text-left outline-none hover:surface-selected-soft focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          picked === thing.id && "surface-selected-soft",
        )}
      >
        <GameThingPicture threadRef={threadRef} thing={thing} build={build} className="size-5" />
        <Text variant="body" tone="default" truncate render={<span className="flex-1" />}>
          {thing.name}
        </Text>
        <Text variant="caption" tone="muted" numeric render={<span className="shrink-0" />}>
          {thing.values?.length ?? 0}
        </Text>
        <span className="flex w-1.5 shrink-0 justify-center">
          {tunedValues(thing).length > 0 ? (
            <span aria-label="tuned" className="size-1.5 rounded-full bg-live" />
          ) : null}
        </span>
      </button>
    </div>
  );
  return (
    <div role="listbox" aria-label="Things in the game" className="flex flex-col gap-1">
      {KIND_GROUPS.map((group) => {
        const rows = things.filter((thing) => thing.kind === group.kind);
        if (rows.length === 0) return null;
        const open = !folded.has(group.kind);
        const Icon = KIND_ICON[group.kind];
        return (
          <div key={group.kind} role="group" aria-label={group.label} className="flex flex-col">
            <div className="px-2">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => {
                  const next = new Set(folded);
                  if (open) next.add(group.kind);
                  else next.delete(group.kind);
                  setFolded(next);
                }}
                className="flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md ps-1 pe-2 text-left text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <ChevronRightIcon
                  aria-hidden="true"
                  className={cn(
                    "size-3.5 shrink-0 motion-popup transition-transform",
                    open && "rotate-90",
                  )}
                />
                <Icon aria-hidden="true" className="size-3.5 shrink-0" />
                <Text variant="meta" tone="inherit" truncate render={<span className="flex-1" />}>
                  {group.label}
                </Text>
                {rows.length > 1 ? (
                  <Text
                    variant="caption"
                    tone="muted"
                    numeric
                    render={<span className="shrink-0" />}
                  >
                    {rows.length}
                  </Text>
                ) : null}
                {/* The rows' tuned-dot column, so the counts line up. */}
                <span aria-hidden="true" className="w-1.5 shrink-0 ps-0.5" />
              </button>
            </div>
            {open ? rows.map(row) : null}
          </div>
        );
      })}
      {things.filter((thing) => thing.kind === "other").map(row)}
    </div>
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

/**
 * The picked thing: its picture, name and kind, pointing at it on the Stage and putting it all
 * back, then its values as rows of real fields.
 */
function ThingInspector({
  threadRef,
  build,
  thing,
  disabled,
}: {
  threadRef: ScopedThreadRef;
  build: string | null;
  thing: GameThing;
  disabled: boolean;
}) {
  const save = use(TuneSave);
  const values = thing.values ?? [];
  const tuned = tunedValues(thing);
  return (
    <section aria-label={`${thing.name}'s values`} className="flex flex-col pb-2">
      <div className="flex h-16 min-w-0 shrink-0 items-center gap-3 ps-4 pe-2">
        <GameThingPicture threadRef={threadRef} thing={thing} build={build} className="size-10" />
        <span className="flex min-w-0 flex-1 flex-col">
          <Text variant="label" tone="strong" truncate render={<h3 />}>
            {thing.name}
          </Text>
          <Text variant="caption" tone="muted">
            {thing.kindWord ?? KIND_WORDS[thing.kind]}
          </Text>
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Point at it on the Stage"
                onClick={() => pointAtStageThing(thing.id)}
              />
            }
          >
            <CrosshairIcon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Point at it on the Stage</TooltipPopup>
        </Tooltip>
        {tuned.length === 0 ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Put ${thing.name}'s values back`}
                  onClick={() => {
                    for (const value of tuned) putBack(thing, value, save);
                  }}
                />
              }
            >
              <RotateCcwIcon aria-hidden="true" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Put {thing.name}'s values back</TooltipPopup>
          </Tooltip>
        )}
      </div>
      {values.map((value) => {
        const changed = value.default !== undefined && value.default !== value.value;
        return (
          <GameTuneField
            key={value.key}
            label={valueLabel(value)}
            value={value}
            was={changed ? value.default : undefined}
            disabled={disabled}
            onChange={(next) => tuneStageValue(thing.id, value.key, next)}
            onCommit={(next, how) => save(thing.id, { ...value, value: next }, how)}
            onReset={changed ? () => putBack(thing, value, save) : undefined}
          />
        );
      })}
    </section>
  );
}

/**
 * Only while something is tuned: how many values differ from the game's own, across how many
 * things, then putting them all back and keeping them as a build. A save that failed says so in
 * place of the count, with Try again.
 */
function TuneFooter({
  changed,
  changedCount,
  state,
  canSave,
  onKeep,
  onRetry,
}: {
  changed: ReadonlyArray<{
    readonly thing: GameThing;
    readonly values: ReadonlyArray<GameThingValue>;
  }>;
  changedCount: number;
  state: SaveState;
  canSave: boolean;
  onKeep: () => void;
  onRetry: () => void;
}) {
  const save = use(TuneSave);
  if (changedCount === 0 && state.kind !== "failed") return null;
  const count = `${changedCount} changed${changed.length > 1 ? ` in ${changed.length} things` : ""}`;
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-t border-border px-4">
      {state.kind === "failed" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Text
                variant="meta"
                tone="destructive"
                truncate
                role="alert"
                render={<span className="min-w-0 flex-1" />}
              />
            }
          >
            Not saved
          </TooltipTrigger>
          <TooltipPopup side="top" className="max-w-sm">
            {state.text}
          </TooltipPopup>
        </Tooltip>
      ) : (
        <Text
          variant="meta"
          tone="muted"
          numeric
          truncate
          role="status"
          render={<span className="min-w-0 flex-1" />}
        >
          {!canSave
            ? `${count}, not saved: this connection cannot change the game`
            : state.kind === "waiting"
              ? `${count}, saved when the agent's turn ends`
              : count}
        </Text>
      )}
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
      <Button
        size="sm"
        variant="secondary"
        disabled={!canSave || state.kind !== "saved"}
        onClick={onKeep}
      >
        Keep as a build
      </Button>
    </div>
  );
}
