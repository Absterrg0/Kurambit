import { useAtomValue } from "@effect/atom-react";
import type { GameThing, GameThingValue, ScopedThreadRef } from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import { threadRuntimeIsActive } from "@kurambit/client-runtime/state/models";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import { ChevronDownIcon, CrosshairIcon, RotateCcwIcon, SlidersHorizontalIcon } from "lucide-react";
import { createContext, use, useEffect, useRef, useState, type ReactNode } from "react";

import { useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { randomUUID } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { gameEnvironment } from "../../state/game";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThingLook, useSelectNotice, valueLabel } from "./GameInspector";
import { GameTuneField, type TuneCommit } from "./GameTuneField";
import { Workbench } from "./GameWorkbenchParts";
import { hoverStageThing, tuneStageValue, useThreadStageBridge } from "./gameStageBridge";

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
function useTuneSaver(threadRef: ScopedThreadRef) {
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

const KIND_GROUPS: ReadonlyArray<{ readonly kind: GameThing["kind"]; readonly label: string }> = [
  { kind: "character", label: "Characters" },
  { kind: "creature", label: "Creatures" },
  { kind: "prop", label: "Props" },
  { kind: "level", label: "Level" },
  { kind: "effect", label: "Effects" },
  { kind: "ui", label: "Interface" },
  { kind: "rule", label: "Rules" },
  { kind: "sound", label: "Sound" },
  { kind: "other", label: "Other" },
];

/**
 * Tune, as an engine's inspector: the things the game names (`ctx.thing`, `ctx.tune`) as a
 * compact list by kind, and the picked thing's values under it as tight rows. Values change the
 * game as they move and save into it as they are let go. Pointing at a thing on the paused Stage
 * picks it here.
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
  const pointed = useThreadStageBridge(threadKey, (state) => state.selected?.thing ?? null, null);
  const saver = useTuneSaver(threadRef);
  const [picked, setPicked] = useState<string | null>(null);
  // A thing pointed at on the Stage is the one picked here, until another is.
  const [followed, setFollowed] = useState<string | null>(null);
  if ((pointed?.id ?? null) !== followed) {
    setFollowed(pointed?.id ?? null);
    if (pointed !== null) setPicked(pointed.id);
  }
  const changed = things
    .map((thing) => ({ thing, values: tunedValues(thing) }))
    .filter((entry) => entry.values.length > 0);
  const changedCount = changed.reduce((sum, entry) => sum + entry.values.length, 0);
  if (notice !== null || status !== "ready")
    return (
      <Workbench.Empty
        icon={<SlidersHorizontalIcon />}
        title={notice?.title ?? "Waiting for the game"}
        body={notice?.body ?? "Its things and values show here once it answers."}
      />
    );
  if (!things.some((thing) => (thing.values?.length ?? 0) > 0))
    return (
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
    );
  // The pointed thing as the game reports it (one of a group), else the listed one picked, else
  // the first with values.
  const shown =
    (pointed !== null && pointed.id === picked ? pointed : null) ??
    things.find((thing) => thing.id === picked) ??
    things.find((thing) => (thing.values?.length ?? 0) > 0) ??
    null;
  return (
    <TuneSave value={saver.save}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {shown === null ? null : (
            <ThingValues
              threadRef={threadRef}
              thing={shown}
              disabled={!tunable}
              picker={
                <ThingPicker
                  things={things}
                  picked={shown}
                  pointed={pointed?.id ?? null}
                  onPick={setPicked}
                />
              }
            />
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

const kindLabel = (kind: GameThing["kind"]) =>
  KIND_GROUPS.find((group) => group.kind === kind)?.label ?? "Other";

/** The things in the outliner's order: by kind, then as the game named them. */
const byKind = (things: ReadonlyArray<GameThing>) =>
  KIND_GROUPS.flatMap((group) => things.filter((thing) => thing.kind === group.kind));

/**
 * The thing whose values show, as one row: its name and kind, opening a searchable menu of every
 * thing the game names, by kind. Pointing at a thing on the Stage picks it here too.
 */
function ThingPicker({
  things,
  picked,
  pointed,
  onPick,
}: {
  things: ReadonlyArray<GameThing>;
  picked: GameThing;
  pointed: string | null;
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const items = byKind(things);
  const needle = query.trim().toLowerCase();
  const shownItems =
    needle === ""
      ? items
      : items.filter(
          (thing) =>
            thing.name.toLowerCase().includes(needle) ||
            kindLabel(thing.kind).toLowerCase().includes(needle),
        );
  return (
    <Combobox
      items={items}
      filteredItems={shownItems}
      autoHighlight
      itemToStringLabel={(thing) => thing.name}
      isItemEqualToValue={(a, b) => a.id === b.id}
      value={items.find((thing) => thing.id === picked.id) ?? null}
      onOpenChange={(open) => {
        if (!open) setQuery("");
        if (!open) hoverStageThing(null);
      }}
      onItemHighlighted={(thing) => hoverStageThing(thing?.id ?? null)}
      onValueChange={(thing) => {
        if (thing !== null) onPick(thing.id);
      }}
    >
      <ComboboxTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="min-w-0"
            aria-label={`${picked.name}, ${kindLabel(picked.kind)}: pick another thing`}
          />
        }
      >
        <Text variant="label" tone="strong" truncate>
          {picked.name}
        </Text>
        <Text variant="caption" tone="muted" render={<span className="shrink-0" />}>
          {kindLabel(picked.kind)}
        </Text>
        <ChevronDownIcon className="shrink-0 text-dim-foreground" aria-hidden="true" />
      </ComboboxTrigger>
      <ComboboxPopup align="start" className="w-72">
        <ComboboxSearchInput
          aria-label="Find a thing"
          placeholder="Find a thing"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxEmpty>Nothing by that name.</ComboboxEmpty>
        <ComboboxList>
          {(thing: GameThing) => {
            const count = thing.values?.length ?? 0;
            return (
              <ComboboxItem key={thing.id} value={thing}>
                <span className="min-w-0 flex-1 truncate">{thing.name}</span>
                {pointed === thing.id ? (
                  <CrosshairIcon className="text-live" aria-label="pointed at" />
                ) : null}
                {tunedValues(thing).length > 0 ? (
                  <span aria-label="tuned" className="size-1.5 shrink-0 rounded-full bg-live" />
                ) : null}
                <Text variant="caption" tone="muted" numeric render={<span className="shrink-0" />}>
                  {kindLabel(thing.kind)}
                  {count === 0 ? "" : ` · ${count}`}
                </Text>
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
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

/** The picked thing's values as tight rows, then where its look comes from. */
function ThingValues({
  threadRef,
  thing,
  disabled,
  picker,
}: {
  threadRef: ScopedThreadRef;
  thing: GameThing;
  disabled: boolean;
  picker: ReactNode;
}) {
  const save = use(TuneSave);
  const values = thing.values ?? [];
  const tuned = tunedValues(thing);
  return (
    <section aria-label={`${thing.name}'s values`} className="flex flex-col pb-2">
      <div className="flex h-11 min-w-0 items-center gap-1 ps-2 pe-2">
        {picker}
        <span className="flex-1" />
        {tuned.length === 0 ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`Put ${thing.name}'s values back to the game's own`}
                  onClick={() => {
                    for (const value of tuned) putBack(thing, value, save);
                  }}
                />
              }
            >
              <RotateCcwIcon aria-hidden="true" />
            </TooltipTrigger>
            <TooltipPopup side="left">Put {thing.name}'s values back</TooltipPopup>
          </Tooltip>
        )}
      </div>
      {thing.instance !== undefined || (thing.instances ?? 0) > 1 ? (
        <Text variant="caption" tone="muted" render={<p className="px-4 pb-1.5" />}>
          {thing.instance !== undefined
            ? `One of ${thing.instance.count}; its values are the group's`
            : `All ${thing.instances} of them`}
        </Text>
      ) : null}
      {values.length === 0 ? (
        <Text variant="meta" tone="muted" render={<p className="px-4 py-1" />}>
          No values to tune. Your agent can expose some with ctx.tune.
        </Text>
      ) : (
        values.map((value) => {
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
        })
      )}
      <div className="px-4 pt-2 empty:hidden">
        <ThingLook threadRef={threadRef} thing={thing} />
      </div>
    </section>
  );
}

/**
 * Only while something is tuned: how many values differ from the game's own and whether they are
 * saved, Keep as a build, and putting them all back.
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
  const said = !canSave
    ? "Playing, not saved: this connection cannot change the game"
    : state.kind === "saving"
      ? "Saving…"
      : state.kind === "waiting"
        ? "Saves when the agent's turn ends"
        : state.kind === "failed"
          ? state.text
          : state.kind === "kept"
            ? "Kept; your next change starts a new build"
            : state.kind === "saved"
              ? "Saved as you let go"
              : "Saved in the game";
  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-border px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-live" />
        <Text variant="meta" tone="default" numeric render={<span className="shrink-0" />}>
          {changedCount === 1 ? "1 changed" : `${changedCount} changed`}
        </Text>
        <Text
          variant="caption"
          tone={state.kind === "failed" ? "destructive" : "muted"}
          truncate
          render={<span role={state.kind === "failed" ? "alert" : "status"} className="flex-1" />}
        >
          {said}
        </Text>
      </div>
      <div className="flex items-center justify-end gap-1.5">
        {state.kind === "failed" ? (
          <Button size="xs" variant="ghost" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            for (const { thing, values } of changed)
              for (const value of values) putBack(thing, value, save);
          }}
        >
          Put all back
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={!canSave || state.kind !== "saved"}
          onClick={onKeep}
        >
          Keep as a build
        </Button>
      </div>
    </div>
  );
}
