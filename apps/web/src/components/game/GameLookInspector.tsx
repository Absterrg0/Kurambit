import { useEffect, useState } from "react";
import {
  gameLookId,
  type GameLookMaterial,
  type GameThing,
  type GameThingValue,
  type ScopedThreadRef,
} from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import { ChevronRightIcon, LinkIcon, UnlinkIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Text } from "../ui/text";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { colourHex } from "./GameColourField";
import { valueLabel } from "./GameInspector";
import { useTuneSaver } from "./GameTune";
import { GameTuneField } from "./GameTuneField";
import { Workbench } from "./GameWorkbenchParts";
import { requestStageLook, tuneStageValue, useThreadStageBridge } from "./gameStageBridge";

const NO_VALUES: ReadonlyArray<GameThingValue> = [];
const isChanged = (value: GameThingValue) =>
  value.default !== undefined && value.default !== value.value;

/** The material a look value belongs to ("3:roof/color" → "3:roof"), or null for the thing's own. */
const materialOf = (key: string) => {
  const slash = key.lastIndexOf("/");
  return slash === -1 ? null : key.slice(0, slash);
};
/** A material's value as its row says it: "Colour", not "Roof colour". */
const fieldLabel = (value: GameThingValue, material: GameLookMaterial) => {
  const label = valueLabel(value);
  const words = label.startsWith(`${material.label} `)
    ? label.slice(material.label.length + 1)
    : label;
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

/**
 * A thing's inspector, the way an engine's inspector shows a selected object: its transform
 * (scale, with x/y/z behind a lock, and its turn about up), each of its materials (colour, glow,
 * roughness, metalness, opacity, flat shading, its texture), its shadows, and its tuned values.
 * Every edit plays at once on the Stage and saves as it is let go, folding into one build like
 * Tune's values; the look is kept in tune.json under `look:<id>`. `onEdit` hears each change, so
 * the viewer above draws it too.
 */
export function GameLookInspector({
  threadRef,
  thing,
  onEdit,
  onBake,
}: {
  threadRef: ScopedThreadRef;
  thing: GameThing;
  onEdit?: (() => void) | undefined;
  /** Asks the agent to move the look into the thing's code: shown while the look has edits. */
  onBake?: ((changed: ReadonlyArray<GameThingValue>) => void) | undefined;
}) {
  const threadKey = scopedThreadKey(threadRef);
  const lookId = gameLookId(thing.id);
  const status = useThreadStageBridge(threadKey, (state) => state.status, null);
  const look = useThreadStageBridge(threadKey, (state) => state.looks[thing.id], undefined);
  const saver = useTuneSaver(threadRef);
  const [locked, setLocked] = useState(true);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  // Asked as the inspector opens and whenever the game comes up again (a new run, a reload).
  useEffect(() => {
    if (status === "ready") requestStageLook(thing.id);
  }, [status, thing.id]);
  const values = look?.values ?? NO_VALUES;
  const own = thing.values ?? NO_VALUES;
  const disabled = !saver.canSave;
  const edit = (id: string, value: GameThingValue, next: number | boolean) => {
    tuneStageValue(id, value.key, next);
    onEdit?.();
  };
  const field = (id: string, value: GameThingValue, label: string) => {
    const changed = isChanged(value);
    const putBack = () => {
      if (value.default === undefined) return;
      edit(id, value, value.default);
      saver.save(id, { ...value, value: value.default }, "keyboard");
    };
    return (
      <GameTuneField
        key={`${id}\0${value.key}`}
        label={label}
        value={value}
        was={changed ? value.default : undefined}
        disabled={disabled}
        onChange={(next) => edit(id, value, next)}
        onCommit={(next, how) => saver.save(id, { ...value, value: next }, how)}
        onReset={changed ? putBack : undefined}
      />
    );
  };
  const byKey = new Map(values.map((value) => [value.key, value]));
  const scale = byKey.get("scale");
  const axes = (["scaleX", "scaleY", "scaleZ"] as const).flatMap((key) => {
    const value = byKey.get(key);
    return value === undefined ? [] : [value];
  });
  const turn = byKey.get("turn");
  const shadows = (["castShadow", "receiveShadow"] as const).flatMap((key) => {
    const value = byKey.get(key);
    return value === undefined ? [] : [value];
  });
  const materials = (look?.materials ?? []).map((material) => ({
    material,
    values: values.filter((value) => materialOf(value.key) === material.key),
  }));
  const lookChanged = values.filter(isChanged);
  const ownChanged = own.filter(isChanged);
  const changedCount = lookChanged.length + ownChanged.length;
  const putAllBack = () => {
    for (const value of lookChanged) {
      edit(lookId, value, value.default!);
      saver.save(lookId, { ...value, value: value.default! }, "keyboard");
    }
    for (const value of ownChanged) {
      edit(thing.id, value, value.default!);
      saver.save(thing.id, { ...value, value: value.default! }, "keyboard");
    }
  };
  return (
    <>
      {look === null || values.length === 0 ? null : (
        <>
          {scale === undefined && turn === undefined ? null : (
            <Workbench.Section
              title="Transform"
              aside={
                scale === undefined ? undefined : (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Toggle
                          size="sm"
                          variant="ghost"
                          pressed={!locked}
                          onPressedChange={(pressed) => setLocked(!pressed)}
                          aria-label="Scale each axis on its own"
                        />
                      }
                    >
                      {locked ? <LinkIcon aria-hidden="true" /> : <UnlinkIcon aria-hidden="true" />}
                    </TooltipTrigger>
                    <TooltipPopup side="left">
                      {locked ? "Scale each axis on its own" : "Scale all axes together"}
                    </TooltipPopup>
                  </Tooltip>
                )
              }
            >
              {scale === undefined ? null : field(lookId, scale, "Scale")}
              {locked ? null : axes.map((value) => field(lookId, value, valueLabel(value)))}
              {turn === undefined ? null : field(lookId, turn, "Turn")}
            </Workbench.Section>
          )}
          {materials.length === 0 ? null : (
            <Workbench.Section title="Materials" detail={materials.length}>
              {materials.map(({ material, values: fields }) => {
                const expanded = open.has(material.key);
                const colour = fields.find((value) => value.key.endsWith("/color"));
                const edited = fields.some(isChanged);
                return (
                  <div key={material.key} className="flex flex-col">
                    <div className="px-2">
                      <button
                        type="button"
                        aria-expanded={expanded}
                        onClick={() => {
                          const next = new Set(open);
                          if (expanded) next.delete(material.key);
                          else next.add(material.key);
                          setOpen(next);
                        }}
                        className="flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md ps-2 pe-2 text-left outline-none hover:surface-selected-soft focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                      >
                        <ChevronRightIcon
                          aria-hidden="true"
                          className={cn(
                            "size-3.5 shrink-0 text-dim-foreground motion-popup transition-transform",
                            expanded && "rotate-90",
                          )}
                        />
                        <span
                          aria-hidden="true"
                          className="size-4 shrink-0 rounded-sm ring-1 ring-border ring-inset"
                          style={
                            typeof colour?.value === "number"
                              ? { backgroundColor: colourHex(colour.value) }
                              : undefined
                          }
                        />
                        <Text
                          variant="body"
                          tone="default"
                          truncate
                          render={<span className="flex-1" />}
                        >
                          {material.label}
                        </Text>
                        <span className="flex w-1.5 shrink-0 justify-center">
                          {edited ? (
                            <span aria-label="changed" className="size-1.5 rounded-full bg-live" />
                          ) : null}
                        </span>
                      </button>
                    </div>
                    {expanded ? (
                      <div className="flex flex-col pb-1">
                        {fields.map((value) => field(lookId, value, fieldLabel(value, material)))}
                        {material.map === undefined ? null : (
                          <div className="grid h-14 grid-cols-[minmax(0,1fr)_8rem_1.5rem] items-center gap-2 px-4">
                            <Text variant="body" tone="muted">
                              Texture
                            </Text>
                            <img
                              src={material.map}
                              alt={`${material.label} texture`}
                              className="size-12 rounded-sm ring-1 ring-border [image-rendering:pixelated]"
                            />
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </Workbench.Section>
          )}
          {shadows.length === 0 ? null : (
            <Workbench.Section title="Shadows">
              {shadows.map((value) =>
                field(lookId, value, value.key === "castShadow" ? "Cast" : "Receive"),
              )}
            </Workbench.Section>
          )}
        </>
      )}
      {own.length === 0 ? null : (
        <Workbench.Section title="Values" detail={own.length}>
          {own.map((value) => field(thing.id, value, valueLabel(value)))}
        </Workbench.Section>
      )}
      {changedCount === 0 && saver.state.kind !== "failed" ? null : (
        <div className="sticky bottom-0 mt-auto flex h-11 shrink-0 items-center gap-0.5 border-t border-border bg-background ps-4 pe-2">
          <Text
            variant="meta"
            tone={saver.state.kind === "failed" ? "destructive" : "muted"}
            numeric
            role="status"
            render={<span className="me-auto shrink-0 whitespace-nowrap" />}
          >
            {saver.state.kind === "failed"
              ? "Not saved"
              : !saver.canSave
                ? `${changedCount} changed, not saved`
                : saver.state.kind === "waiting"
                  ? `${changedCount} changed, saved when the turn ends`
                  : `${changedCount} changed`}
          </Text>
          {saver.state.kind === "failed" ? (
            <Button size="sm" variant="ghost" onClick={saver.retry}>
              Try again
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" disabled={disabled} onClick={putAllBack}>
            Put all back
          </Button>
          {onBake === undefined || lookChanged.length === 0 ? null : (
            <Button size="sm" variant="ghost" onClick={() => onBake(lookChanged)}>
              Bake into the code
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled || saver.state.kind !== "saved"}
            onClick={saver.keepAsBuild}
          >
            Keep as a build
          </Button>
        </div>
      )}
    </>
  );
}
