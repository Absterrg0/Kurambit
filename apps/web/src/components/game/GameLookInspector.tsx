import { useEffect, useState, type ReactNode } from "react";
import {
  gameLookId,
  type GameLookMaterial,
  type GameThing,
  type GameThingValue,
  type ScopedThreadRef,
} from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import {
  EllipsisIcon,
  EyeIcon,
  EyeOffIcon,
  LinkIcon,
  RotateCcwIcon,
  SearchIcon,
  UnlinkIcon,
} from "lucide-react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import {
  PropertyColourField,
  PropertyLabel,
  PropertyNumberField,
  PropertyReading,
  PropertyRow,
  PropertySection,
} from "../ui/property-field";
import { Switch } from "../ui/switch";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { valueLabel } from "./GameInspector";
import { GameThingValueRows, type useTuneSaver } from "./GameTune";
import { GameTuneField } from "./GameTuneField";

type TuneSaver = ReturnType<typeof useTuneSaver>;
import {
  nameStageThing,
  requestStageLook,
  tuneStageValue,
  useThreadStageBridge,
} from "./gameStageBridge";

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
 * A label being renamed in place: Enter or leaving it keeps the name, Escape keeps the old one,
 * and an empty name gives back the game's own.
 */
export function LabelInput({
  label,
  onRename,
  onDone,
}: {
  label: string;
  onRename: (name: string | null) => void;
  onDone: () => void;
}) {
  const [value, setValue] = useState(label);
  const [settled, setSettled] = useState(false);
  const finish = (keep: boolean) => {
    if (settled) return;
    setSettled(true);
    const next = value.replace(/\s+/g, " ").trim();
    if (keep && next !== label) onRename(next === "" ? null : next);
    onDone();
  };
  return (
    <Input
      aria-label={`Rename ${label}`}
      placeholder="The game's own name"
      value={value}
      maxLength={40}
      size="sm"
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") finish(true);
        if (event.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}

/** Renames a look's part or material: shown at once on the Stage, kept with the look as a build. */
export const renameLook = (saver: TuneSaver, lookId: string, key: string, name: string | null) => {
  nameStageThing(lookId, key, name);
  saver.rename(lookId, key, name);
};

/** A size as three read-only fields, wide, tall and long. */
export function SizeRow({ size }: { size: readonly [number, number, number] }) {
  return (
    <PropertyRow label="Size">
      {(["W", "H", "D"] as const).map((axis, index) => (
        <PropertyReading
          key={axis}
          prefix={axis}
          value={size[index]!.toFixed(2)}
          title={`${["Wide", "Tall", "Long"][index]}: ${size[index]} in the game's units`}
        />
      ))}
    </PropertyRow>
  );
}

/** A one-line tip on an icon button. */
function IconAction({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost-muted"
            aria-label={label}
            aria-pressed={pressed}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** Materials past this many get a filter. */
const FILTER_FROM = 9;

/**
 * A thing's inspector, the way Figma and Spline lay one out: Transform (scale as X, Y and Z fields
 * with a lock between the axes, the turn about up as one ° field, and its size as read-only W, H
 * and D), its materials as fill rows (swatch, hex, opacity and an eye, the rest behind ⋯), its
 * shadows as two switches on one row, and its tuned values as Tune shows them. Every edit plays at
 * once on the Stage and saves as it is let go, folding into one build like Tune's values; the look
 * is kept in tune.json under `look:<id>`. `onEdit` hears each change, so the viewer above draws it.
 */
export function GameLookInspector({
  threadRef,
  thing,
  saver,
  size,
  onEdit,
  onBake,
}: {
  threadRef: ScopedThreadRef;
  thing: GameThing;
  /**
   * The detail view's saver: it outlives a new run, when the game names its things again and
   * this inspector's thing is briefly gone, so Keep as a build still keeps the session.
   */
  saver: TuneSaver;
  /** Its bounds, wide, tall, long, when known. */
  size?: readonly [number, number, number] | null | undefined;
  onEdit?: (() => void) | undefined;
  /** Asks the agent to move the look into the thing's code: shown while the look has edits. */
  onBake?: ((changed: ReadonlyArray<GameThingValue>) => void) | undefined;
}) {
  const threadKey = scopedThreadKey(threadRef);
  const lookId = gameLookId(thing.id);
  const status = useThreadStageBridge(threadKey, (state) => state.status, null);
  const look = useThreadStageBridge(threadKey, (state) => state.looks[thing.id], undefined);
  const canName = useThreadStageBridge(
    threadKey,
    (state) => state.capabilities.includes("names"),
    false,
  );
  const [locked, setLocked] = useState(true);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
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
  const commit = (value: GameThingValue, next: number | boolean, how: "pointer" | "keyboard") =>
    saver.save(lookId, { ...value, value: next }, how);
  const putBack = (value: GameThingValue) => {
    if (value.default === undefined) return;
    edit(lookId, value, value.default);
    saver.save(lookId, { ...value, value: value.default }, "keyboard");
  };
  const field = (value: GameThingValue, label: string) => {
    const changed = isChanged(value);
    return (
      <GameTuneField
        key={value.key}
        nested
        label={label}
        value={value}
        was={changed ? value.default : undefined}
        disabled={disabled}
        onChange={(next) => edit(lookId, value, next)}
        onCommit={(next, how) => commit(value, next, how)}
        onReset={changed ? () => putBack(value) : undefined}
      />
    );
  };
  const byKey = new Map(values.map((value) => [value.key, value]));
  const scale = byKey.get("scale");
  const axes = (["scaleX", "scaleY", "scaleZ"] as const).map((key) => byKey.get(key));
  const turn = byKey.get("turn");
  const cast = byKey.get("castShadow");
  const receive = byKey.get("receiveShadow");
  const materials = (look?.materials ?? []).map((material) => ({
    material,
    values: values.filter((value) => materialOf(value.key) === material.key),
  }));
  const anyNamed = materials.some(({ material }) => material.named === true);
  const needle = filter.trim().toLowerCase();
  const listed =
    materials.length < FILTER_FROM || needle === ""
      ? materials
      : materials.filter(({ material }) => material.label.toLowerCase().includes(needle));
  const lookChanged = values.filter(isChanged);
  const ownChanged = own.filter(isChanged);
  const changedCount = lookChanged.length + ownChanged.length;
  const putAllBack = () => {
    for (const value of lookChanged) putBack(value);
    for (const value of ownChanged) {
      edit(thing.id, value, value.default!);
      saver.save(thing.id, { ...value, value: value.default! }, "keyboard");
    }
  };
  const transformChanged = [scale, ...axes, turn].filter(
    (value): value is GameThingValue => value !== undefined && isChanged(value),
  );
  const scaleNumber = typeof scale?.value === "number" ? scale.value : 1;
  // One scale field per axis: the thing's scale times that axis's own. Locked, any of them scales
  // all three together; unlocked, each sets its own axis.
  const axisFields =
    scale === undefined
      ? null
      : (["X", "Y", "Z"] as const).map((letter, index) => {
          const axis = axes[index];
          const factor = typeof axis?.value === "number" ? axis.value : 1;
          const target = locked || axis === undefined ? scale : axis;
          const toTarget = (shown: number) =>
            Math.round(
              (locked || axis === undefined ? shown / factor : shown / scaleNumber) * 1000,
            ) / 1000;
          return (
            <PropertyNumberField
              key={letter}
              label={`Scale ${letter}`}
              prefix={letter}
              value={Math.round(scaleNumber * factor * 100) / 100}
              step={0.01}
              min={0.05}
              max={100}
              tuned={isChanged(scale) || (axis !== undefined && isChanged(axis))}
              disabled={disabled}
              onChange={(shown) => edit(lookId, target, toTarget(shown))}
              onCommit={(shown, how) => commit(target, toTarget(shown), how)}
            />
          );
        });
  const hasTransform = scale !== undefined || turn !== undefined || (size ?? null) !== null;
  return (
    <>
      {!hasTransform ? null : (
        <PropertySection
          title="Transform"
          actions={
            transformChanged.length === 0 ? undefined : (
              <IconAction
                label="Put the transform back"
                onClick={() => {
                  for (const value of transformChanged) putBack(value);
                }}
              >
                <RotateCcwIcon aria-hidden="true" />
              </IconAction>
            )
          }
        >
          {axisFields === null ? null : (
            <PropertyRow
              label="Scale"
              end={
                axes.some((axis) => axis !== undefined) ? (
                  <IconAction
                    label={locked ? "Scale each axis on its own" : "Scale all axes together"}
                    pressed={locked}
                    onClick={() => setLocked(!locked)}
                  >
                    {locked ? <LinkIcon aria-hidden="true" /> : <UnlinkIcon aria-hidden="true" />}
                  </IconAction>
                ) : undefined
              }
            >
              {axisFields}
            </PropertyRow>
          )}
          {turn === undefined || typeof turn.value !== "number" ? null : (
            <PropertyRow label="Turn">
              <PropertyNumberField
                label="Turn"
                value={turn.value}
                min={turn.min}
                max={turn.max}
                step={turn.step}
                unit="°"
                tuned={isChanged(turn)}
                disabled={disabled}
                onChange={(next) => edit(lookId, turn, next)}
                onCommit={(next, how) => commit(turn, next, how)}
              />
              <span aria-hidden="true" className="flex-1" />
              <span aria-hidden="true" className="flex-1" />
            </PropertyRow>
          )}
          {size === undefined || size === null ? null : <SizeRow size={size} />}
        </PropertySection>
      )}
      {materials.length === 0 ? null : (
        <PropertySection title="Materials" count={materials.length}>
          {materials.length < FILTER_FROM ? null : (
            <div className="px-4 pb-2">
              <InputGroup variant="field">
                <InputGroupAddon>
                  <SearchIcon className="size-3.5" />
                </InputGroupAddon>
                <InputGroupInput
                  nativeInput
                  size="compact"
                  type="text"
                  value={filter}
                  placeholder="Filter materials"
                  aria-label="Filter materials"
                  onChange={(event) => setFilter(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Escape") setFilter("");
                  }}
                />
              </InputGroup>
            </div>
          )}
          {listed.map(({ material, values: fields }) => {
            const expanded = open.has(material.key);
            const at = (prop: string) => fields.find((value) => value.key.endsWith(`/${prop}`));
            const colour = at("color");
            const opacity = at("opacity");
            const shown = at("visible");
            const advanced = fields.filter(
              (value) => value !== colour && value !== opacity && value !== shown,
            );
            const edited = fields.filter(isChanged);
            const label =
              renaming === material.key ? (
                <LabelInput
                  label={material.label}
                  onRename={(name) => renameLook(saver, lookId, `${material.key}/name`, name)}
                  onDone={() => setRenaming(null)}
                />
              ) : material.named === true ? (
                <span
                  className="flex min-w-0"
                  onDoubleClick={(event) => {
                    if (!canName || disabled) return;
                    event.preventDefault();
                    setRenaming(material.key);
                  }}
                >
                  <PropertyLabel
                    title={canName && !disabled ? "Double-click to rename" : undefined}
                  >
                    {material.label}
                  </PropertyLabel>
                </span>
              ) : anyNamed ? (
                <span />
              ) : undefined;
            return (
              <div key={material.key} className="group/material flex flex-col">
                <PropertyRow
                  label={label}
                  end={
                    edited.length === 0 ? undefined : (
                      <IconAction
                        label={`Put ${material.label} back`}
                        onClick={() => {
                          for (const value of edited) putBack(value);
                        }}
                      >
                        <RotateCcwIcon aria-hidden="true" />
                      </IconAction>
                    )
                  }
                >
                  {colour === undefined || typeof colour.value !== "number" ? (
                    <PropertyReading value={material.label} />
                  ) : (
                    <PropertyColourField
                      label={material.label}
                      value={colour.value}
                      tuned={isChanged(colour)}
                      hidden={shown?.value === false}
                      disabled={disabled}
                      onChange={(next) => edit(lookId, colour, next)}
                      onCommit={(next) => commit(colour, next, "pointer")}
                      {...(opacity === undefined || typeof opacity.value !== "number"
                        ? {}
                        : {
                            opacity: {
                              value: opacity.value,
                              tuned: isChanged(opacity),
                              disabled,
                              onChange: (next: number) => edit(lookId, opacity, next),
                              onCommit: (next: number, how: "pointer" | "keyboard") =>
                                commit(opacity, next, how),
                            },
                          })}
                    />
                  )}
                  {shown === undefined || typeof shown.value !== "boolean" ? null : (
                    <IconAction
                      label={shown.value ? `Hide ${material.label}` : `Show ${material.label}`}
                      pressed={!shown.value}
                      onClick={() => {
                        edit(lookId, shown, !shown.value);
                        commit(shown, !shown.value, "pointer");
                      }}
                    >
                      {shown.value ? (
                        <EyeIcon aria-hidden="true" />
                      ) : (
                        <EyeOffIcon aria-hidden="true" />
                      )}
                    </IconAction>
                  )}
                  {advanced.length === 0 && material.map === undefined ? null : (
                    <span
                      className={
                        expanded
                          ? "flex"
                          : "flex opacity-0 group-hover/material:opacity-100 has-focus-visible:opacity-100"
                      }
                    >
                      <IconAction
                        label={
                          expanded
                            ? `Hide ${material.label}'s settings`
                            : `${material.label}'s settings`
                        }
                        pressed={expanded}
                        onClick={() => {
                          const next = new Set(open);
                          if (expanded) next.delete(material.key);
                          else next.add(material.key);
                          setOpen(next);
                        }}
                      >
                        <EllipsisIcon aria-hidden="true" />
                      </IconAction>
                    </span>
                  )}
                </PropertyRow>
                {expanded ? (
                  <div className="flex flex-col pb-1">
                    {advanced.map((value) => field(value, fieldLabel(value, material)))}
                    {material.map === undefined ? null : (
                      <PropertyRow label="Texture" nested>
                        <img
                          src={material.map}
                          alt={`${material.label} texture`}
                          className="size-12 rounded-sm ring-1 ring-border [image-rendering:pixelated]"
                        />
                      </PropertyRow>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
          {listed.length === 0 ? (
            <Text variant="meta" tone="muted" render={<p className="px-4 py-1" />}>
              Nothing matches “{filter.trim()}”.
            </Text>
          ) : null}
        </PropertySection>
      )}
      {cast === undefined && receive === undefined ? null : (
        <PropertySection title="Shadows">
          <PropertyRow>
            {[
              { value: cast, word: "Casts" },
              { value: receive, word: "Takes" },
            ].map(({ value, word }) =>
              value === undefined || typeof value.value !== "boolean" ? null : (
                <label key={word} className="flex flex-1 cursor-pointer items-center gap-2">
                  <Switch
                    size="sm"
                    checked={value.value}
                    disabled={disabled}
                    onCheckedChange={(checked) => {
                      edit(lookId, value, checked);
                      commit(value, checked, "pointer");
                    }}
                  />
                  <Text variant="meta" tone={isChanged(value) ? "default" : "muted"}>
                    {word}
                  </Text>
                </label>
              ),
            )}
          </PropertyRow>
        </PropertySection>
      )}
      {own.length === 0 ? null : (
        <PropertySection title="Values" count={own.length}>
          <GameThingValueRows
            id={thing.id}
            values={own}
            disabled={disabled}
            save={saver.save}
            onEdit={onEdit}
          />
        </PropertySection>
      )}
      {changedCount === 0 && saver.state.kind !== "failed" ? null : (
        <div className="sticky bottom-0 mt-auto flex h-11 shrink-0 items-center border-t border-border bg-background ps-4 pe-1">
          <Text
            variant="caption"
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
            <Button size="xs" variant="ghost" onClick={saver.retry}>
              Try again
            </Button>
          ) : null}
          <Button size="xs" variant="ghost" disabled={disabled} onClick={putAllBack}>
            Put all back
          </Button>
          {onBake === undefined || lookChanged.length === 0 ? null : (
            <Button size="xs" variant="ghost" onClick={() => onBake(lookChanged)}>
              Bake into the code
            </Button>
          )}
          <Button
            size="xs"
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
