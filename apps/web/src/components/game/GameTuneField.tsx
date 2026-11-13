import { NumberField } from "@base-ui/react/number-field";
import { Slider } from "@base-ui/react/slider";
import type { GameThingValue } from "@kurambit/contracts";

import { cn } from "../../lib/utils";
import { NumberFieldInput } from "../ui/number-field";
import { Switch } from "../ui/switch";
import { Text } from "../ui/text";

/**
 * One tuned value as an engine's inspector shows it: its name (drag it to scrub), a number field
 * to type into, and a short slider over the range the game registered. A value changed from what
 * the game started with carries the live colour, and says what it was.
 */
export function GameTuneField({
  label,
  value,
  was,
  disabled,
  onChange,
}: {
  label: string;
  value: GameThingValue;
  was: number | boolean | undefined;
  disabled: boolean;
  onChange: (next: number | boolean) => void;
}) {
  const changed = was !== undefined;
  if (typeof value.value === "boolean")
    return (
      <div className="grid h-7 grid-cols-[minmax(0,7rem)_1fr] items-center gap-2 ps-6 pe-3">
        <Text variant="meta" tone="default" truncate>
          {label}
        </Text>
        <div className="flex items-center gap-2">
          <Switch
            checked={value.value}
            disabled={disabled}
            onCheckedChange={(checked) => onChange(checked)}
            aria-label={label}
          />
          {changed ? (
            <Text variant="caption" tone="muted">
              was {was ? "on" : "off"}
            </Text>
          ) : null}
        </div>
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
      className="grid h-7 grid-cols-[minmax(0,7rem)_4.25rem_1fr] items-center gap-2 ps-6 pe-3"
      data-changed={changed ? "" : undefined}
    >
      <NumberField.ScrubArea className="min-w-0 cursor-ew-resize select-none">
        <Text variant="meta" tone="default" truncate render={<span className="block" />}>
          {label}
        </Text>
      </NumberField.ScrubArea>
      <NumberField.Group className="contents">
        <NumberFieldInput variant="inspector" aria-label={label} />
      </NumberField.Group>
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
          <Slider.Control className="flex h-5 w-full touch-none items-center">
            <Slider.Track className="relative h-0.75 w-full rounded-full bg-foreground/10">
              <Slider.Indicator
                className={cn("rounded-full", changed ? "bg-live" : "bg-muted-foreground")}
              />
              <Slider.Thumb className="size-2.5 rounded-full bg-strong-foreground shadow-sm outline-none ring-2 ring-background focus-visible:ring-ring" />
            </Slider.Track>
          </Slider.Control>
        </Slider.Root>
      ) : (
        <span />
      )}
    </NumberField.Root>
  );
}

/** A slider step a person would type: 1, 2 or 5 times a power of ten. */
const niceStep = (raw: number) => {
  if (!(raw > 0)) return 0.01;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit < 1.5 ? 1 : unit < 3.5 ? 2 : 5) * power;
};
