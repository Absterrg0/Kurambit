import type { GameThingValue } from "@kurambit/contracts";
import { RotateCcwIcon } from "lucide-react";

import { Button } from "../ui/button";
import {
  colourHex,
  PropertyColourField,
  PropertyNumberRow,
  PropertyRow,
  type PropertyCommit,
} from "../ui/property-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * How a change ended: a pointer let go (the game takes the keys back), or the keyboard (focus
 * stays, so arrows keep stepping the value).
 */
export type TuneCommit = PropertyCommit;

const unitText = (value: GameThingValue, number: number) =>
  `${number}${value.unit === undefined ? "" : ` ${value.unit}`}`;

/**
 * One tuned value as an inspector row: its label (which scrubs a number), then its field. A
 * number is a 24 px field with its unit and a thin fill for where it sits in its range; a choice
 * picks by name, a switch flips, a colour is a fill field. It changes the game as it moves
 * (`onChange`) and saves when let go (`onCommit`). A value tuned away from the game's own is in
 * the live colour, with a reset in the row's end slot.
 */
export function GameTuneField({
  label,
  value,
  was,
  disabled,
  onChange,
  onCommit,
  onReset,
  nested = false,
}: {
  label: string;
  value: GameThingValue;
  was: number | boolean | undefined;
  disabled: boolean;
  onChange: (next: number | boolean) => void;
  onCommit: (next: number | boolean, how: TuneCommit) => void;
  onReset?: (() => void) | undefined;
  /** A setting of the row above it: its label starts further in. */
  nested?: boolean;
}) {
  const reset = <ResetSlot was={was} value={value} onReset={onReset} />;
  if (typeof value.value === "boolean")
    return (
      <PropertyRow label={label} end={reset} nested={nested}>
        <Switch
          size="sm"
          checked={value.value}
          disabled={disabled}
          onCheckedChange={(checked) => {
            onChange(checked);
            onCommit(checked, "pointer");
          }}
          aria-label={label}
        />
      </PropertyRow>
    );
  const number = value.value;
  if (value.colour === true)
    return (
      <PropertyRow label={label} end={reset} nested={nested}>
        <PropertyColourField
          label={label}
          value={number}
          tuned={was !== undefined}
          disabled={disabled}
          onChange={onChange}
          onCommit={(next) => onCommit(next, "pointer")}
        />
      </PropertyRow>
    );
  if (value.choices !== undefined && value.choices.length > 1) {
    const choices = value.choices;
    return (
      <PropertyRow label={label} end={reset} nested={nested}>
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
          <SelectTrigger size="xs" className="min-w-0 flex-1" aria-label={label}>
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
      </PropertyRow>
    );
  }
  return (
    <PropertyNumberRow
      label={label}
      value={number}
      min={value.min}
      max={value.max}
      step={value.step}
      unit={value.unit}
      tuned={was !== undefined}
      disabled={disabled}
      range
      onChange={onChange}
      onCommit={onCommit}
      end={reset}
      nested={nested}
    />
  );
}

/** Puts one value back, with what it was in its tooltip; nothing at the game's own. */
export function ResetSlot({
  was,
  value,
  onReset,
}: {
  was: number | boolean | undefined;
  value: GameThingValue;
  onReset: (() => void) | undefined;
}) {
  if (was === undefined || onReset === undefined) return null;
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
            size="icon-micro"
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
