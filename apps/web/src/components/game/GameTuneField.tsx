import { NumberField } from "@base-ui/react/number-field";
import { Slider } from "@base-ui/react/slider";
import type { GameThingValue } from "@kurambit/contracts";
import { RotateCcwIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { NumberFieldInput } from "../ui/number-field";
import { Switch } from "../ui/switch";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** One row's columns: name, control, number, and the reset slot (kept so rows line up). */
const ROW =
  "grid h-8 grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_3.75rem_1.5rem] items-center gap-2 ps-4 pe-1.5";

/**
 * One tuned value as an engine's inspector shows it: its name (drag it to scrub), a slider over
 * the range the game registered, and the number to type. A value changed from what the game
 * started with carries the live colour, says what it was, and puts it back from its reset.
 */
export function GameTuneField({
  label,
  value,
  was,
  disabled,
  onChange,
  onReset,
}: {
  label: string;
  value: GameThingValue;
  was: number | boolean | undefined;
  disabled: boolean;
  onChange: (next: number | boolean) => void;
  onReset?: (() => void) | undefined;
}) {
  const changed = was !== undefined;
  const reset = <ResetSlot was={was} onReset={onReset} />;
  if (typeof value.value === "boolean")
    return (
      <div className={ROW}>
        <Name label={label} changed={changed} />
        <span />
        <span className="flex justify-end">
          <Switch
            checked={value.value}
            disabled={disabled}
            onCheckedChange={(checked) => onChange(checked)}
            aria-label={label}
          />
        </span>
        {reset}
      </div>
    );
  const number = value.value;
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
      className={cn(ROW, "hover:bg-accent/50")}
      data-changed={changed ? "" : undefined}
    >
      <NumberField.ScrubArea className="min-w-0 cursor-ew-resize select-none">
        <Name label={label} changed={changed} />
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
      <NumberField.Group className="contents">
        <NumberFieldInput variant="inspector" aria-label={label} />
      </NumberField.Group>
      {reset}
    </NumberField.Root>
  );
}

function Name({ label, changed }: { label: string; changed: boolean }) {
  return (
    <Text
      variant="meta"
      tone={changed ? "inherit" : "muted"}
      truncate
      render={<span className={cn("block", changed && "text-live")} />}
    >
      {label}
    </Text>
  );
}

/** Puts one value back, with what it was in its tooltip; an empty slot when it is unchanged. */
function ResetSlot({
  was,
  onReset,
}: {
  was: number | boolean | undefined;
  onReset: (() => void) | undefined;
}) {
  if (was === undefined || onReset === undefined) return <span />;
  const before = typeof was === "boolean" ? (was ? "on" : "off") : String(was);
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
      <TooltipPopup side="left">Was {before}</TooltipPopup>
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
