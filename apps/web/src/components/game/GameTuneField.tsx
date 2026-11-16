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

/** One row's columns: the name and its unit, the field, and the reset slot (kept so rows line up). */
const ROW = "grid h-7 grid-cols-[minmax(0,2fr)_minmax(0,3fr)_1.5rem] items-center gap-2 ps-4 pe-2";

/**
 * How a change ended: a pointer let go (the game takes the keys back), or the keyboard (focus
 * stays, so arrows keep stepping the value).
 */
export type TuneCommit = "pointer" | "keyboard";

const unitText = (value: GameThingValue, number: number) =>
  `${number}${value.unit === undefined ? "" : ` ${value.unit}`}`;

/**
 * One tuned value as an engine's inspector shows it: its name and unit, and a number field to
 * drag sideways to scrub (as Blender and Figma do), click to type, with how far it sits in the
 * range the game registered as a faint fill. A choice picks by name, a switch flips. It changes
 * the game as it moves (`onChange`) and saves when let go (`onCommit`). A value tuned away from
 * the game's own carries a small mark and a reset to put it back.
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
  const name = <Name label={label} unit={value.unit} changed={was !== undefined} />;
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
  const share = ranged ? Math.min(1, Math.max(0, (number - min) / (max - min))) : null;
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
              className="relative min-w-0 cursor-ew-resize overflow-hidden rounded-md surface-well select-none has-focus:cursor-text"
              onPointerDown={() => {
                pressedAt.current = number;
              }}
            />
          }
        >
          {/* The range fill is the field's own background: how far the value sits between the
              game's limits, under the number. */}
          {share === null ? null : (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 left-0 bg-foreground/10"
              style={{ width: `${share * 100}%` }}
            />
          )}
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
        </TooltipTrigger>
        <TooltipPopup side="left">
          {ranged ? `${unitText(value, min)} to ${unitText(value, max)}` : label}
          {" · drag to change, click to type"}
        </TooltipPopup>
      </Tooltip>
      {reset}
    </NumberField.Root>
  );
}

/** The value's name with its unit after it, quieter; a small mark before a tuned one. */
function Name({
  label,
  unit,
  changed,
}: {
  label: string;
  unit?: string | undefined;
  changed: boolean;
}) {
  return (
    <span className="relative flex min-w-0 items-center">
      {changed ? (
        <span aria-label="tuned" className="absolute -start-2.5 size-1.5 rounded-full bg-live" />
      ) : null}
      <Text variant="meta" tone="default" truncate>
        {label}
        {unit === undefined ? null : <span className="ms-1.5 text-dim-foreground">{unit}</span>}
      </Text>
    </span>
  );
}

/** Puts one value back, with what it was in its tooltip; an empty slot when it is unchanged. */
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
  );
}

/** A drag step a person would type: 1, 2 or 5 times a power of ten. */
const niceStep = (raw: number) => {
  if (!(raw > 0)) return 0.01;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit < 1.5 ? 1 : unit < 3.5 ? 2 : 5) * power;
};
