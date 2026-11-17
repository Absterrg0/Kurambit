import { useRef } from "react";
import { NumberField } from "@base-ui/react/number-field";
import type { GameThingValue } from "@kurambit/contracts";
import { RotateCcwIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { NumberFieldInput } from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { colourHex, GameColourField } from "./GameColourField";

/**
 * One row's grid, the same in every row: the label, the 128 px field, and the reset slot (kept so
 * the fields line up whether a row has a reset or not).
 */
const ROW = "grid h-8 grid-cols-[minmax(0,1fr)_8rem_1.5rem] items-center gap-2 px-4";

/**
 * How a change ended: a pointer let go (the game takes the keys back), or the keyboard (focus
 * stays, so arrows keep stepping the value).
 */
export type TuneCommit = "pointer" | "keyboard";

const unitText = (value: GameThingValue, number: number) =>
  `${number}${value.unit === undefined ? "" : ` ${value.unit}`}`;

/**
 * One tuned value as an engine's inspector shows it: its label, then a real field holding the
 * value with its unit, a 2 px bar along its bottom edge for where it sits in its range (as Godot's
 * spin-slider does). Click the field to type, drag it or the label sideways to scrub. A choice
 * picks by name, a switch flips, a colour opens a picker. It changes the game as it moves
 * (`onChange`) and saves when let go (`onCommit`). A value tuned away from the game's own is in
 * the live colour, with a reset to put it back.
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
  const name = (
    <Text variant="body" tone="muted" truncate>
      {label}
    </Text>
  );
  const reset = <ResetSlot was={was} value={value} onReset={onReset} />;
  if (typeof value.value === "boolean")
    return (
      <div className={ROW}>
        {name}
        <span className="flex">
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
  if (value.colour === true)
    return (
      <div className={ROW}>
        {name}
        <span className="flex">
          <GameColourField
            label={label}
            value={number}
            disabled={disabled}
            onChange={onChange}
            onCommit={(next) => onCommit(next, "pointer")}
          />
        </span>
        {reset}
      </div>
    );
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
        // A press on the field that moved nothing leaves it focused to type in.
        if (from !== next) onCommit(next, "pointer");
      }}
      className={ROW}
    >
      {/* Dragging the label scrubs too, as an engine's inspector's labels do. */}
      <NumberField.ScrubArea
        className="flex min-w-0 cursor-ew-resize select-none"
        onPointerDown={() => {
          pressedAt.current = number;
        }}
      >
        {name}
      </NumberField.ScrubArea>
      <Tooltip>
        <TooltipTrigger
          render={
            <NumberField.ScrubArea
              data-tuned={was === undefined ? undefined : ""}
              className="relative flex h-7 min-w-0 cursor-ew-resize items-center gap-1 overflow-hidden rounded-md px-2 select-none surface-well has-focus:cursor-text has-focus:surface-focus"
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
            <Text variant="body" tone="muted" render={<span className="shrink-0" />}>
              {value.unit}
            </Text>
          )}
          {share === null ? null : (
            <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 bg-foreground/8">
              <span
                className={cn(
                  "block h-full",
                  was === undefined ? "bg-muted-foreground" : "bg-live",
                )}
                style={{ width: `${share * 100}%` }}
              />
            </span>
          )}
        </TooltipTrigger>
        <TooltipPopup side="left">
          {ranged ? `${unitText(value, min)} to ${unitText(value, max)}` : "Drag or type"}
        </TooltipPopup>
      </Tooltip>
      {reset}
    </NumberField.Root>
  );
}

/** Puts one value back, with what it was in its tooltip; an empty slot at the game's own. */
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
      : value.colour === true
        ? colourHex(was).toUpperCase()
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
