import { NumberField } from "@base-ui/react/number-field";
import { Slider } from "@base-ui/react/slider";
import type { GameThingValue } from "@kurambit/contracts";
import { RotateCcwIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { NumberFieldInput } from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** One row's columns: name, control, number, and the reset slot (kept so rows line up). */
const ROW =
  "grid h-8 grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_3.75rem_1.5rem] items-center gap-2 ps-4 pe-1.5";

/**
 * How a change ended: a pointer let go (the game takes the keys back), or the keyboard (focus
 * stays, so arrows keep stepping the value).
 */
export type TuneCommit = "pointer" | "keyboard";

/**
 * One tuned value as an engine's inspector shows it: its name (drag it to scrub), a slider over
 * the range the game registered, and the number to type; a choice picks by name. It changes the
 * game as it moves (`onChange`) and saves when let go (`onCommit`). A value tuned away from the
 * game's own carries the live colour, says what the game's own is, and puts it back from its reset.
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
  const changed = was !== undefined;
  const reset = <ResetSlot was={was} value={value} onReset={onReset} />;
  if (typeof value.value === "boolean")
    return (
      <div className={ROW}>
        <Name label={label} changed={changed} />
        <span />
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
      <div className={ROW} data-changed={changed ? "" : undefined}>
        <Name label={label} changed={changed} />
        {/* The picker takes the slider's and the number's columns. */}
        <div className="col-span-2 flex min-w-0">
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
        </div>
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
        if (next !== null && Number.isFinite(next))
          onCommit(next, details.reason === "scrub" ? "pointer" : "keyboard");
      }}
      className={cn(ROW, "hover:bg-accent/50")}
      data-changed={changed ? "" : undefined}
    >
      <NumberField.ScrubArea className="min-w-0 cursor-ew-resize select-none">
        <Name label={label} unit={value.unit} changed={changed} />
      </NumberField.ScrubArea>
      {ranged ? (
        <Slider.Root
          value={number}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onValueChange={(next) => {
            const single = Array.isArray(next) ? next[0] : next;
            if (typeof single === "number") onChange(single);
          }}
          onValueCommitted={(next, details) => {
            const single = Array.isArray(next) ? next[0] : next;
            if (typeof single === "number")
              onCommit(single, details.reason === "keyboard" ? "keyboard" : "pointer");
          }}
          aria-label={label}
        >
          <Slider.Control className="flex h-6 w-full touch-none items-center">
            <Slider.Track className="relative h-1 w-full rounded-full bg-foreground/10">
              <Slider.Indicator
                className={cn("rounded-full", changed ? "bg-live" : "bg-foreground/35")}
              />
              <Slider.Thumb className="size-3 rounded-full bg-strong-foreground shadow-sm outline-none ring-2 ring-background focus-visible:ring-ring" />
            </Slider.Track>
          </Slider.Control>
        </Slider.Root>
      ) : (
        <span />
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
        <NumberFieldInput variant="inspector" aria-label={label} />
      </NumberField.Group>
      {reset}
    </NumberField.Root>
  );
}

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
    <Text
      variant="meta"
      tone={changed ? "inherit" : "muted"}
      truncate
      render={<span className={cn("block", changed && "text-live")} />}
    >
      {label}
      {unit === undefined ? null : <span className="ms-1 text-dim-foreground">{unit}</span>}
    </Text>
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
      : (value.choices?.[Math.round(was)] ??
        `${was}${value.unit === undefined ? "" : ` ${value.unit}`}`);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
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

/** A slider step a person would type: 1, 2 or 5 times a power of ten. */
const niceStep = (raw: number) => {
  if (!(raw > 0)) return 0.01;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit < 1.5 ? 1 : unit < 3.5 ? 2 : 5) * power;
};
