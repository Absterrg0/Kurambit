import { useAtomValue } from "@effect/atom-react";
import type { GameThing, GameThingValue, ScopedThreadRef } from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import { threadRuntimeIsActive } from "@kurambit/client-runtime/state/models";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import {
  ChevronRightIcon,
  CrosshairIcon,
  RotateCcwIcon,
  SearchIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { createContext, use, useEffect, useRef, useState } from "react";

import { useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { cn, randomUUID } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { gameEnvironment } from "../../state/game";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useSelectNotice, valueLabel } from "./GameInspector";
import { GameThingPicture, useStageBuild } from "./GameThingPicture";
import { GameTuneField, type TuneCommit } from "./GameTuneField";
import { useThreadGameName } from "./GameName";
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
  // Names given a look's part or materials, by look id and key (null: back to the game's own).
  const nameQueue = useRef(new Map<string, Map<string, string | null>>());
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
    while (queue.current.size > 0 || nameQueue.current.size > 0) {
      if (turnRunning) {
        setState({ kind: "waiting" });
        break;
      }
      setState({ kind: "saving" });
      const named = nameQueue.current;
      const things = [...new Set([...queue.current.keys(), ...named.keys()])].map((id) => {
        const names = [...(named.get(id) ?? [])].map(([key, name]) => ({ key, name }));
        return {
          id,
          values: [...(queue.current.get(id)?.values() ?? [])],
          ...(names.length === 0 ? {} : { names }),
        };
      });
      queue.current = new Map();
      nameQueue.current = new Map();
      const fold = !fresh.current;
      fresh.current = false;
      const result = await keep({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, things, commandId: randomUUID(), fold },
      });
      if (result._tag === "Failure") {
        // Back under anything tuned since, which is newer.
        for (const thing of things) {
          if (thing.values.length > 0) {
            const values = queue.current.get(thing.id) ?? new Map<string, GameThingValue>();
            for (const value of thing.values)
              if (!values.has(value.key)) values.set(value.key, value);
            queue.current.set(thing.id, values);
          }
          if (thing.names === undefined) continue;
          const names = nameQueue.current.get(thing.id) ?? new Map<string, string | null>();
          for (const { key, name } of thing.names) if (!names.has(key)) names.set(key, name);
          nameQueue.current.set(thing.id, names);
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
  /** A name given a look's part ("name") or material ("2:roof/name"), kept like a value. */
  const rename = useStableCallback((id: string, key: string, name: string | null) => {
    const names = nameQueue.current.get(id) ?? new Map<string, string | null>();
    names.set(key, name);
    nameQueue.current.set(id, names);
    void flush();
  });
  const keepAsBuild = () => {
    fresh.current = true;
    setState({ kind: "kept" });
  };
  return { save, rename, state, canSave, keepAsBuild, retry: () => void flush() };
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
 * PURE. The chip beside a thing's name: the game's own word for it, only when that says more than
 * the group's heading above it ("player" under Characters). A word that repeats the heading
 * ("rule" under Rules) is left out, and so is the kind when the game gave no word of its own.
 */
const kindChip = (thing: Pick<GameThing, "kind" | "kindWord">): string | null => {
  const word = thing.kindWord?.trim() ?? "";
  if (word === "") return null;
  const said = word.toLowerCase();
  const heading = KIND_GROUPS.find((group) => group.kind === thing.kind)?.label.toLowerCase();
  return said === KIND_WORDS[thing.kind] || said === heading ? null : word;
};

/** "Hopper and Flag", "Hopper, Flag and 3 more": the things a game named; null with none. */
export const namesOf = (things: ReadonlyArray<GameThing>): string | null => {
  const names = [...new Set(things.map((thing) => thing.name.replace(/ \d+$/, "")))];
  if (names.length === 0) return null;
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
};

/**
 * Tune, as one scrolling inspector the way Unity lists components and Spline its sections: each
 * thing the game named with values is a section of value rows, grouped by kind under thin labels,
 * with a filter on top. Values change the game as they move and save into it as they are let go.
 * Pointing at a thing on the paused Stage brings its section into view and marks it.
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
  const [filter, setFilter] = useState("");
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const scroller = useRef<HTMLDivElement>(null);
  const picked = pointed?.id ?? null;
  // A thing pointed at on the Stage opens and comes into view, scrolled to the top only when
  // the panel cannot already show all of it.
  const [followed, setFollowed] = useState<string | null>(null);
  if (picked !== followed) {
    setFollowed(picked);
    if (picked !== null && folded.has(picked)) {
      const next = new Set(folded);
      next.delete(picked);
      setFolded(next);
    }
  }
  useEffect(() => {
    if (picked === null) return;
    const frame = requestAnimationFrame(() => {
      const box = scroller.current;
      const section = box?.querySelector<HTMLElement>(
        `[data-thing-section="${CSS.escape(picked)}"]`,
      );
      if (box === null || box === undefined || section === null || section === undefined) return;
      const view = box.getBoundingClientRect();
      const at = section.getBoundingClientRect();
      // The filter row stays on top of the scroller: what hides under it is out of view too.
      const top = view.top + FILTER_PX;
      if (at.top >= top && at.bottom <= view.bottom) return;
      box.scrollTop += at.top - top;
    });
    return () => cancelAnimationFrame(frame);
  }, [picked]);
  const things = all.filter(hasValues);
  // A thing picked on the Stage with no values still gets its section, saying so.
  const listed = pointed === null || hasValues(pointed) ? things : [...things, pointed];
  const changed = things
    .map((thing) => ({ thing, values: tunedValues(thing) }))
    .filter((entry) => entry.values.length > 0);
  const changedCount = changed.reduce((sum, entry) => sum + entry.values.length, 0);
  // With nothing to tune, the one thing to do names what the game already has.
  const gameName = useThreadGameName(threadRef);
  const named = namesOf(all);
  const subject = named ?? (gameName || "the game");
  if (notice !== null || status !== "ready")
    return (
      <Workbench.Empty icon={<SlidersHorizontalIcon />} body={notice ?? "Waiting for the game."} />
    );
  if (listed.length === 0)
    return (
      <Workbench.Empty
        icon={<SlidersHorizontalIcon />}
        body="Tunable numbers appear here."
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              onAsk(
                `Make ${subject}'s key numbers tunable from the Stage: the player's speed and jump height, enemy speeds and counts, timers and the win and lose targets.`,
              )
            }
          >
            {named === null ? `Make ${subject}'s numbers tunable` : `Make ${named} tunable`}
          </Button>
        }
      />
    );
  const needle = filter.trim().toLowerCase();
  // A filter keeps a thing whose name matches, or the values of it whose label does.
  const shown = listed.flatMap(
    (
      thing,
    ): ReadonlyArray<{
      readonly thing: GameThing;
      readonly only: ReadonlyArray<GameThingValue> | null;
    }> => {
      if (needle === "" || thing.name.toLowerCase().includes(needle))
        return [{ thing, only: null }];
      const only = (thing.values ?? []).filter((value) =>
        valueLabel(value).toLowerCase().includes(needle),
      );
      return only.length === 0 ? [] : [{ thing, only }];
    },
  );
  const groups = [
    ...KIND_GROUPS.map((group) => ({
      key: group.kind,
      label: group.label as string | null,
      rows: shown.filter((entry) => entry.thing.kind === group.kind),
    })),
    { key: "other", label: null, rows: shown.filter((entry) => entry.thing.kind === "other") },
  ].filter((group) => group.rows.length > 0);
  return (
    <TuneSave value={saver.save}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div ref={scroller} className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2">
          <div className="sticky top-0 z-10 flex h-11 shrink-0 items-center bg-background px-4">
            <InputGroup variant="field">
              <InputGroupAddon>
                <SearchIcon className="size-3.5" />
              </InputGroupAddon>
              <InputGroupInput
                nativeInput
                size="compact"
                type="text"
                value={filter}
                placeholder="Filter"
                aria-label="Filter things and values"
                onChange={(event) => setFilter(event.currentTarget.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Escape") setFilter("");
                }}
              />
            </InputGroup>
          </div>
          {groups.length === 0 ? (
            <Text variant="meta" tone="muted" render={<p className="px-4 py-3" />}>
              Nothing matches “{filter.trim()}”.
            </Text>
          ) : null}
          {groups.map((group) => (
            <div key={group.key} role="group" aria-label={group.label ?? undefined}>
              {group.label === null ? null : (
                <div className="flex h-8 items-end gap-1.5 px-4 pb-1.5">
                  <Text variant="caption" tone="muted">
                    {group.label}
                  </Text>
                  <span aria-hidden="true" className="mb-1.5 h-px flex-1 bg-border" />
                </div>
              )}
              {group.rows.map(({ thing, only }) => (
                <ThingSection
                  key={thing.id}
                  threadRef={threadRef}
                  build={build}
                  thing={thing}
                  only={only}
                  picked={thing.id === picked}
                  open={!folded.has(thing.id) || only !== null}
                  disabled={!tunable}
                  onOpenChange={(open) => {
                    const next = new Set(folded);
                    if (open) next.delete(thing.id);
                    else next.add(thing.id);
                    setFolded(next);
                  }}
                />
              ))}
            </div>
          ))}
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

/** The sticky filter row's height, which a section scrolled into view must clear. */
const FILTER_PX = 44;

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
 * A thing's values as inspector rows, the body of its Tune section and of Art's Values: each plays
 * as it moves (`onEdit` hears it too) and is kept as it is let go.
 */
function GameThingValueRows({
  id,
  values,
  disabled,
  save,
  onEdit,
}: {
  id: string;
  values: ReadonlyArray<GameThingValue>;
  disabled: boolean;
  save: (id: string, value: GameThingValue, how: TuneCommit) => void;
  onEdit?: (() => void) | undefined;
}) {
  return values.map((value) => {
    const changed = value.default !== undefined && value.default !== value.value;
    return (
      <GameTuneField
        key={value.key}
        label={valueLabel(value)}
        value={value}
        was={changed ? value.default : undefined}
        disabled={disabled}
        onChange={(next) => {
          tuneStageValue(id, value.key, next);
          onEdit?.();
        }}
        onCommit={(next, how) => save(id, { ...value, value: next }, how)}
        onReset={
          changed
            ? () => {
                if (value.default === undefined) return;
                tuneStageValue(id, value.key, value.default);
                onEdit?.();
                save(id, { ...value, value: value.default }, "keyboard");
              }
            : undefined
        }
      />
    );
  });
}

/**
 * One thing's section: its picture, name and the game's word for it when the heading has not
 * said it (kindChip), putting it back when tuned and
 * pointing at it on the Stage, then its values. A click on the name picks it on the Stage too;
 * hovering outlines it there while the Stage is frozen. The thing pointed at on the Stage is marked.
 */
function ThingSection({
  threadRef,
  build,
  thing,
  only,
  picked,
  open,
  disabled,
  onOpenChange,
}: {
  threadRef: ScopedThreadRef;
  build: string | null;
  thing: GameThing;
  /** A filter's matching values, when the thing's name did not match. */
  only: ReadonlyArray<GameThingValue> | null;
  picked: boolean;
  open: boolean;
  disabled: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const save = use(TuneSave);
  const tuned = tunedValues(thing);
  const valueless = !hasValues(thing);
  const chip = kindChip(thing);
  return (
    <section
      aria-label={`${thing.name}'s values`}
      data-thing-section={thing.id}
      className="flex flex-col border-b border-border last:border-b-0"
    >
      <div
        className={cn(
          "group/thing flex h-10 min-w-0 shrink-0 items-center gap-1 ps-2 pe-2",
          picked && "surface-selected-soft",
        )}
        onPointerEnter={() => hoverStageThing(thing.id)}
        onPointerLeave={() => hoverStageThing(null)}
      >
        {valueless ? (
          <span aria-hidden="true" className="size-6 shrink-0" />
        ) : (
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? `Fold ${thing.name}` : `Open ${thing.name}`}
            onClick={() => onOpenChange(!open)}
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-dim-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <ChevronRightIcon
              aria-hidden="true"
              className={cn("size-3.5 motion-popup transition-transform", open && "rotate-90")}
            />
          </button>
        )}
        <button
          type="button"
          aria-current={picked ? "true" : undefined}
          onClick={() => selectStageThing(thing.id)}
          className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <GameThingPicture threadRef={threadRef} thing={thing} build={build} className="size-6" />
          <Text variant="meta" tone="strong" emphasis truncate render={<h3 />}>
            {thing.name}
          </Text>
          {chip === null ? null : (
            <Badge variant="muted" size="sm">
              {chip}
            </Badge>
          )}
          {tuned.length === 0 ? null : (
            <span aria-label="tuned" className="size-1.5 shrink-0 rounded-full bg-live" />
          )}
          {valueless ? (
            <Text variant="meta" tone="muted" render={<span className="ms-auto shrink-0 pe-1" />}>
              No values
            </Text>
          ) : null}
        </button>
        {tuned.length === 0 ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
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
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Point at it on the Stage"
                onClick={() => pointAtStageThing(thing.id)}
              />
            }
          >
            <CrosshairIcon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Point at it on the Stage</TooltipPopup>
        </Tooltip>
      </div>
      {open && !valueless ? (
        <div className="flex flex-col pt-0.5 pb-2">
          <GameThingValueRows
            id={thing.id}
            values={only ?? thing.values ?? []}
            disabled={disabled}
            save={save}
          />
        </div>
      ) : null}
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
              : state.kind === "kept"
                ? `${count}, kept as a build`
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
