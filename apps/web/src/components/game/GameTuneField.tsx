import { useRef } from "react";
import { NumberField } from "@base-ui/react/number-field";
import type { GameThingValue } from "@kurambit/contracts";
import { RotateCcwIcon } from "lucide-react";

import { Button } from "../ui/button";
import { NumberFieldInput } from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * One row's grid, the same in every row: the name, the value right-aligned in a fixed column, and
 * the reset slot (kept so the values line up whether a row has a reset or not).
 */
const ROW = "group/value grid h-8 grid-cols-[minmax(0,1fr)_7rem_1.5rem] items-center gap-2 px-4";

/**
 * How a change ended: a pointer let go (the game takes the keys back), or the keyboard (focus
 * stays, so arrows keep stepping the value).
 */
export type TuneCommit = "pointer" | "keyboard";

const unitText = (value: GameThingValue, number: number) =>
  `${number}${value.unit === undefined ? "" : ` ${value.unit}`}`;

/**
 * One tuned value as an engine's inspector shows it: its name, and its value with its unit in a
 * borderless field to drag sideways to scrub (as Blender and Figma do) or click to type, its range
 * in the tooltip. A choice picks by name, a switch flips. It changes the game as it moves
 * (`onChange`) and saves when let go (`onCommit`). A value tuned away from the game's own carries
 * a small mark before its name and, on hover, a reset to put it back.
 */
export function GameTuneField({
  label,
  value,
  was,
  disabled,
  onChange,
  onCommit,
  onReset,
}: {
  label: string;
  value: GameThingValue;
  was: number | boolean | undefined;
  disabled: boolean;
  onChange: (next: number | boolean) => void;
  onCommit: (next: number | boolean, how: TuneCommit) => void;
  onReset?: (() => void) | undefined;
}) {
  // The value a press on the field started from: a press that moved nothing is a click to type.
  const pressedAt = useRef<number | null>(null);
  const name = <Name label={label} changed={was !== undefined} />;
  const reset = <ResetSlot was={was} value={value} onReset={onReset} />;
  if (typeof value.value === "boolean")
    return (
      <div className={ROW}>
        {name}
        <span className="flex justify-end">
          <Switch
            checked={value.value}
            disabled={disabled}
            onCheckedChange={(checked) => {
              onChange(checked);
              onCommit(checked, "pointer");
            }}
            aria-label={label}
          />
        </span>
        {reset}
      </div>
    );
  const number = value.value;
  if (value.choices !== undefined && value.choices.length > 1) {
    const choices = value.choices;
    return (
      <div className={ROW}>
        {name}
        <Select
          value={String(Math.round(number))}
          disabled={disabled}
          onValueChange={(next) => {
            const index = Number(next);
            if (!Number.isInteger(index)) return;
            onChange(index);
            onCommit(index, "pointer");
          }}
        >
          <SelectTrigger size="xs" className="min-w-0" aria-label={label}>
            <SelectValue>{choices[Math.round(number)] ?? String(number)}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {choices.map((choice, index) => (
              <SelectItem key={choice} hideIndicator value={String(index)}>
                {choice}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {reset}
      </div>
    );
  }
  const min = value.min;
  const max = value.max;
  const ranged = min !== undefined && max !== undefined && max > min;
  const step = value.step ?? (ranged ? niceStep((max - min) / 100) : 0.01);
  return (
    <NumberField.Root
      value={number}
      {...(min === undefined ? {} : { min })}
      {...(max === undefined ? {} : { max })}
      step={step}
      smallStep={step / 10}
      largeStep={step * 10}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null && Number.isFinite(next)) onChange(next);
      }}
      onValueCommitted={(next, details) => {
        if (next === null || !Number.isFinite(next)) return;
        if (details.reason !== "scrub") {
          onCommit(next, "keyboard");
          return;
        }
        const from = pressedAt.current;
        pressedAt.current = null;
        // A press that moved nothing leaves the field focused to type in.
        if (from !== next) onCommit(next, "pointer");
      }}
      className={ROW}
    >
      {name}
      <Tooltip>
        <TooltipTrigger
          render={
            <NumberField.ScrubArea
              className="flex h-7 min-w-0 cursor-ew-resize items-center rounded-md px-2 select-none hover:bg-accent has-focus:cursor-text has-focus:bg-accent"
              onPointerDown={() => {
                pressedAt.current = number;
              }}
            />
          }
        >
          {/* Enter keeps the typed number and hands the keys back to the game, as a drag does. */}
          <NumberField.Group
            className="contents"
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement)) return;
              event.preventDefault();
              const typed = Number(event.target.value);
              if (Number.isFinite(typed)) onCommit(typed, "pointer");
            }}
          >
            <NumberFieldInput variant="scrub" aria-label={label} />
          </NumberField.Group>
          {value.unit === undefined ? null : (
            <Text variant="body" tone="muted" render={<span className="shrink-0 ps-1" />}>
              {value.unit}
            </Text>
          )}
        </TooltipTrigger>
        <TooltipPopup side="left">
          {ranged ? `${unitText(value, min)} to ${unitText(value, max)} · ` : ""}
          Drag to change, click to type
        </TooltipPopup>
      </Tooltip>
      {reset}
    </NumberField.Root>
  );
}

/** The value's name, with the live mark before it when it is tuned away from the game's own. */
function Name({ label, changed }: { label: string; changed: boolean }) {
  return (
    <span className="relative flex min-w-0 items-center">
      {changed ? (
        <span aria-label="tuned" className="absolute -start-2.5 size-1.5 rounded-full bg-live" />
      ) : null}
      <Text variant="body" tone="default" truncate>
        {label}
      </Text>
    </span>
  );
}

/**
 * Puts one value back, with what it was in its tooltip, shown while the row is hovered or the
 * reset itself has focus; an empty slot when the value is the game's own.
 */
function ResetSlot({
  was,
  value,
  onReset,
}: {
  was: number | boolean | undefined;
  value: GameThingValue;
  onReset: (() => void) | undefined;
}) {
  if (was === undefined || onReset === undefined) return <span />;
  const before =
    typeof was === "boolean"
      ? was
        ? "on"
        : "off"
      : (value.choices?.[Math.round(was)] ?? unitText(value, was));
  return (
    <span className="flex opacity-0 group-hover/value:opacity-100 focus-within:opacity-100">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={`Put back to ${before}`}
              onClick={onReset}
            />
          }
        >
          <RotateCcwIcon aria-hidden="true" />
        </TooltipTrigger>
        <TooltipPopup side="left">The game's own: {before}</TooltipPopup>
      </Tooltip>
    </span>
  );
}

/** A drag step a person would type: 1, 2 or 5 times a power of ten. */
const niceStep = (raw: number) => {
  if (!(raw > 0)) return 0.01;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit < 1.5 ? 1 : unit < 3.5 ? 2 : 5) * power;
};
