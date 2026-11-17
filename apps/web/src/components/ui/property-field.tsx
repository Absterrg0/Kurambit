import { NumberField } from "@base-ui/react/number-field";
import { ChevronRightIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { hexToHsv, hsvToHex, type HsvColor } from "~/lib/color";
import { cn } from "~/lib/utils";
import { ColorHueSlider, ColorSaturationValuePlane } from "./color-picker";
import { Popover, PopoverPopup, PopoverTrigger } from "./popover";
import { Text } from "./text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

/*
 * An inspector's sections, rows and fields, in the shape Figma's and Spline's property panels use:
 * small strong section headers with their actions as icons at the right and a hairline between
 * sections; rows on one grid (a muted label column, the fields, a 24 px end slot for a reset or a
 * lock); 24 px fields with a flat fill, a muted prefix inside ("W", "X", "°") and tabular figures.
 * Compound values are side-by-side fields of equal width, never prose.
 */

/** How a change ended: a pointer let go, or the keyboard (focus stays, so arrows keep stepping). */
export type PropertyCommit = "pointer" | "keyboard";

const FIELD =
  "relative flex h-6 min-w-0 flex-1 items-center gap-1.5 overflow-hidden rounded-sm px-1.5 surface-field";

/**
 * A section: its title (12 px, strong) with a quieter count, its actions at the right, and a
 * chevron that folds it when `collapsible`. Sections are parted by one hairline.
 */
export function PropertySection({
  title,
  count,
  actions,
  collapsible = false,
  open: controlledOpen,
  onOpenChange,
  label,
  className,
  children,
}: {
  title: ReactNode;
  count?: ReactNode;
  actions?: ReactNode;
  collapsible?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The section's accessible name, when the title is not plain text. */
  label?: string;
  className?: string;
  children?: ReactNode;
}) {
  const [ownOpen, setOwnOpen] = useState(true);
  const open = controlledOpen ?? ownOpen;
  const toggle = () => {
    setOwnOpen(!open);
    onOpenChange?.(!open);
  };
  const heading = (
    <>
      <Text variant="meta" tone="strong" emphasis truncate render={<h3 />}>
        {title}
      </Text>
      {count === undefined || count === null || count === "" ? null : (
        <Text variant="caption" tone="muted" numeric render={<span className="shrink-0" />}>
          {count}
        </Text>
      )}
    </>
  );
  return (
    <section
      aria-label={label ?? (typeof title === "string" ? title : undefined)}
      className={cn("flex flex-col border-b border-border last:border-b-0", className)}
    >
      <div className="flex h-9 min-w-0 shrink-0 items-center gap-1 ps-4 pe-2">
        {collapsible ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={toggle}
            className="-ms-1 flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md ps-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            {heading}
            <ChevronRightIcon
              aria-hidden="true"
              className={cn(
                "size-3 shrink-0 text-dim-foreground motion-popup transition-transform",
                open && "rotate-90",
              )}
            />
          </button>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-1.5">{heading}</span>
        )}
        {actions === undefined ? null : (
          <span className="flex shrink-0 items-center gap-0.5">{actions}</span>
        )}
      </div>
      {open ? <div className="flex flex-col pb-3">{children}</div> : null}
    </section>
  );
}

/**
 * One row on the inspector's grid: a muted label column (left out, the fields take its width), the
 * fields side by side at equal widths, and a 24 px end slot that keeps fields aligned whether or
 * not a row has a reset or a lock.
 */
/** The row grid; a nested row's label starts 12 px further in, its fields in the same column. */
const rowGrid = (nested: boolean) =>
  nested
    ? "grid min-h-8 min-w-0 grid-cols-[5.75rem_minmax(0,1fr)_1.5rem] items-center gap-x-2 ps-7 pe-2"
    : "grid min-h-8 min-w-0 grid-cols-[6.5rem_minmax(0,1fr)_1.5rem] items-center gap-x-2 ps-4 pe-2";

export function PropertyRow({
  label,
  end,
  nested = false,
  className,
  children,
}: {
  label?: ReactNode;
  end?: ReactNode;
  /** A setting of the row above it, such as a material's roughness under its fill. */
  nested?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn(rowGrid(nested), className)}>
      {label === undefined ? null : typeof label === "string" ? (
        <PropertyLabel>{label}</PropertyLabel>
      ) : (
        label
      )}
      <div className={cn("flex min-w-0 items-center gap-2", label === undefined && "col-span-2")}>
        {children}
      </div>
      <span className="flex h-6 items-center justify-center">{end}</span>
    </div>
  );
}

export function PropertyLabel({
  children,
  title,
}: {
  children: ReactNode;
  title?: string | undefined;
}) {
  return (
    <Text
      variant="meta"
      tone="muted"
      truncate
      title={title}
      render={<span className="leading-6" />}
    >
      {children}
    </Text>
  );
}

/** A field's prefix inside it: a letter ("W") or a 12 px icon, muted. */
function Prefix({ children }: { children: ReactNode }) {
  return (
    <span className="relative flex w-3 shrink-0 justify-center text-meta text-muted-foreground [&_svg]:size-3">
      {children}
    </span>
  );
}

/** A value to read, not edit: the field's shape with no hover, so it does not invite a click. */
export function PropertyReading({
  prefix,
  value,
  unit,
  title,
}: {
  prefix?: ReactNode;
  value: ReactNode;
  unit?: string;
  /** What the reading is, in a tooltip. */
  title?: string;
}) {
  const reading = (
    <span className={cn(FIELD, "cursor-default")}>
      {prefix === undefined ? null : <Prefix>{prefix}</Prefix>}
      <Text variant="meta" tone="default" numeric truncate render={<span className="flex-1" />}>
        {value}
      </Text>
      {unit === undefined ? null : (
        <Text variant="meta" tone="muted" render={<span className="shrink-0" />}>
          {unit}
        </Text>
      )}
    </span>
  );
  if (title === undefined) return reading;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex min-w-0 flex-1" />}>{reading}</TooltipTrigger>
      <TooltipPopup side="bottom">{title}</TooltipPopup>
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

export type PropertyNumberProps = {
  /** Its accessible name: the row's label, or "Scale X". */
  label: string;
  value: number;
  min?: number | undefined;
  max?: number | undefined;
  step?: number | undefined;
  unit?: string | undefined;
  /** Inside the field, before the number: a letter or an icon. */
  prefix?: ReactNode;
  /** Changed from its default: the number takes the live colour. */
  tuned?: boolean;
  disabled?: boolean;
  /** Draws where the value sits in its range as a thin fill inside the field. */
  range?: boolean;
  onChange: (next: number) => void;
  onCommit: (next: number, how: PropertyCommit) => void;
};

/**
 * The field of a number: its prefix, the number in tabular figures, its unit muted, and, with a
 * range, a fill inside it up to where the value sits (Figma's slider fields). Drag the field or its
 * row's label sideways to scrub, click to type; Enter keeps a typed number and lets go, as a drag
 * does. It changes as it moves (`onChange`) and is kept when let go (`onCommit`).
 */
function useNumberField(props: PropertyNumberProps) {
  // The value a press started from: a press that moved nothing is a click to type.
  const pressedAt = useRef<number | null>(null);
  const { value, min, max } = props;
  const ranged = min !== undefined && max !== undefined && max > min;
  const step = props.step ?? (ranged ? niceStep((max - min) / 100) : 0.01);
  const rootProps = {
    value,
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    step,
    smallStep: step / 10,
    largeStep: step * 10,
    disabled: props.disabled === true,
    onValueChange: (next: number | null) => {
      if (next !== null && Number.isFinite(next)) props.onChange(next);
    },
    onValueCommitted: (next: number | null, details: { reason: string }) => {
      if (next === null || !Number.isFinite(next)) return;
      if (details.reason !== "scrub") {
        props.onCommit(next, "keyboard");
        return;
      }
      const from = pressedAt.current;
      pressedAt.current = null;
      if (from !== next) props.onCommit(next, "pointer");
    },
  };
  const press = () => {
    pressedAt.current = value;
  };
  const share = ranged ? Math.min(1, Math.max(0, (value - min) / (max - min))) : null;
  const tip = ranged
    ? `${min}${props.unit === undefined ? "" : ` ${props.unit}`} to ${max}${props.unit === undefined ? "" : ` ${props.unit}`}`
    : null;
  const field = (
    <NumberField.ScrubArea
      data-tuned={props.tuned === true ? "" : undefined}
      className={cn(
        FIELD,
        "cursor-ew-resize select-none hover:surface-field-hover has-focus:cursor-text has-focus:surface-focus",
        props.disabled === true && "pointer-events-none opacity-64",
      )}
      onPointerDown={press}
    >
      {props.range === true && share !== null ? (
        <span
          aria-hidden="true"
          className={cn(
            "absolute inset-y-0 start-0",
            props.tuned === true ? "bg-live/16" : "bg-foreground/7",
          )}
          style={{ width: `${share * 100}%` }}
        />
      ) : null}
      {props.prefix === undefined ? null : <Prefix>{props.prefix}</Prefix>}
      <NumberField.Group
        className="relative flex min-w-0 flex-1"
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement)) return;
          event.preventDefault();
          const typed = Number(event.target.value);
          if (Number.isFinite(typed)) props.onCommit(typed, "pointer");
        }}
      >
        <NumberField.Input
          aria-label={props.label}
          className="h-5 w-full min-w-0 cursor-[inherit] bg-transparent text-start text-meta tabular-nums text-foreground outline-none in-data-tuned:text-live focus:cursor-text"
        />
      </NumberField.Group>
      {props.unit === undefined ? null : (
        <span className="relative shrink-0 text-meta text-muted-foreground">{props.unit}</span>
      )}
    </NumberField.ScrubArea>
  );
  return { rootProps, press, field, tip };
}

/** A number field on its own, beside others in a row ("X 1.00  Y 1.00  Z 1.00"). */
export function PropertyNumberField(props: PropertyNumberProps) {
  const { rootProps, field, tip } = useNumberField(props);
  return (
    <NumberField.Root {...rootProps} className="flex min-w-0 flex-1">
      {tip === null ? (
        field
      ) : (
        <Tooltip>
          <TooltipTrigger render={<span className="flex min-w-0 flex-1" />}>{field}</TooltipTrigger>
          <TooltipPopup side="bottom">{tip}</TooltipPopup>
        </Tooltip>
      )}
    </NumberField.Root>
  );
}

/**
 * A row holding one number: its label, which scrubs it too (an engine inspector's labels do), the
 * field, and the end slot.
 */
export function PropertyNumberRow({
  end,
  nested = false,
  ...props
}: PropertyNumberProps & { end?: ReactNode; nested?: boolean }) {
  const { rootProps, press, field, tip } = useNumberField(props);
  return (
    <NumberField.Root {...rootProps} className={rowGrid(nested)}>
      <NumberField.ScrubArea
        className="flex min-w-0 cursor-ew-resize select-none"
        onPointerDown={press}
      >
        <PropertyLabel title={props.label}>{props.label}</PropertyLabel>
      </NumberField.ScrubArea>
      {tip === null ? (
        field
      ) : (
        <Tooltip>
          <TooltipTrigger render={<span className="flex min-w-0" />}>{field}</TooltipTrigger>
          <TooltipPopup side="left">{tip}</TooltipPopup>
        </Tooltip>
      )}
      <span className="flex h-6 items-center justify-center">{end}</span>
    </NumberField.Root>
  );
}

/** A colour as a game keeps it, 0xRRGGBB, as "#rrggbb". */
export const colourHex = (value: number) =>
  `#${Math.max(0, Math.min(0xffffff, Math.round(value)))
    .toString(16)
    .padStart(6, "0")}`;
const colourNumber = (hex: string) => Number.parseInt(hex.replace("#", ""), 16);

/**
 * A colour as Figma's fill row holds it, in one field: the swatch (it opens a picker), the hex,
 * typed in place, and, when given, the opacity in per cent after a divider. Edits play as they move
 * (`onChange`) and are kept when let go or when a typed hex is whole (`onCommit`).
 */
export function PropertyColourField({
  label,
  value,
  tuned = false,
  disabled = false,
  hidden = false,
  opacity,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  tuned?: boolean;
  disabled?: boolean;
  /** Hidden (its row's eye is off): the field dims, still editable. */
  hidden?: boolean;
  /** The opacity, 0 to 1, as a second part of the field. */
  opacity?: Omit<PropertyNumberProps, "label" | "min" | "max" | "unit" | "prefix" | "range">;
  onChange: (next: number) => void;
  onCommit: (next: number) => void;
}) {
  const hex = colourHex(value);
  const [hsv, setHsv] = useState<HsvColor>(() => hexToHsv(hex));
  const [draft, setDraft] = useState<string | null>(null);
  // A value changed from outside (a reset, the Stage) moves the picker with it.
  const [seen, setSeen] = useState(hex);
  if (seen !== hex) {
    setSeen(hex);
    if (hsvToHex(hsv.h, hsv.s, hsv.v).toLowerCase() !== hex) setHsv(hexToHsv(hex));
  }
  const move = (next: HsvColor) => {
    setHsv(next);
    onChange(colourNumber(hsvToHex(next.h, next.s, next.v)));
  };
  const keep = () => onCommit(colourNumber(hsvToHex(hsv.h, hsv.s, hsv.v)));
  return (
    <span
      className={cn(
        FIELD,
        "gap-0 ps-1 pe-0 hover:surface-field-hover has-focus:surface-focus",
        disabled && "pointer-events-none opacity-64",
        hidden && "*:opacity-48",
      )}
    >
      <Popover>
        <PopoverTrigger
          disabled={disabled}
          aria-label={`${label}: ${hex.toUpperCase()}, open the picker`}
          className="flex size-4 shrink-0 cursor-pointer rounded-xs ring-1 ring-foreground/12 ring-inset outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          style={{ backgroundColor: hex }}
        />
        <PopoverPopup side="left" align="start" sideOffset={8} padding="none">
          <div className="w-56">
            <ColorSaturationValuePlane
              label={label}
              value={hsv}
              onChange={move}
              onInteractionEnd={keep}
              variant="edge"
            />
            <div className="p-3">
              <ColorHueSlider
                label={`${label} hue`}
                value={hsv.h}
                onChange={(h) => move({ ...hsv, h })}
                onInteractionEnd={keep}
              />
            </div>
          </div>
        </PopoverPopup>
      </Popover>
      <input
        aria-label={`${label} as hex`}
        spellCheck={false}
        disabled={disabled}
        value={draft ?? hex.slice(1).toUpperCase()}
        maxLength={7}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => {
          const typed = event.currentTarget.value.trim().replace(/^#/, "");
          setDraft(typed);
          if (!/^[\da-f]{6}$/i.test(typed)) return;
          setHsv(hexToHsv(`#${typed}`));
          onChange(colourNumber(typed));
          onCommit(colourNumber(typed));
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur();
        }}
        onBlur={() => setDraft(null)}
        data-tuned={tuned ? "" : undefined}
        className="h-5 w-full min-w-0 flex-1 bg-transparent ps-2 text-meta tabular-nums text-foreground uppercase outline-none data-tuned:text-live"
      />
      {opacity === undefined ? null : (
        <>
          <span aria-hidden="true" className="h-full w-px shrink-0 bg-background" />
          <OpacityPart label={label} {...opacity} />
        </>
      )}
    </span>
  );
}

/** The fill field's opacity part: 0 to 100 in per cent, kept as 0 to 1. */
function OpacityPart({
  label,
  value,
  tuned,
  disabled,
  onChange,
  onCommit,
}: { label: string } & NonNullable<Parameters<typeof PropertyColourField>[0]["opacity"]>) {
  const pressedAt = useRef<number | null>(null);
  const percent = Math.round(value * 100);
  return (
    <NumberField.Root
      value={percent}
      min={0}
      max={100}
      step={1}
      disabled={disabled === true}
      onValueChange={(next) => {
        if (next !== null && Number.isFinite(next)) onChange(next / 100);
      }}
      onValueCommitted={(next, details) => {
        if (next === null || !Number.isFinite(next)) return;
        if (details.reason !== "scrub") {
          onCommit(next / 100, "keyboard");
          return;
        }
        const from = pressedAt.current;
        pressedAt.current = null;
        if (from !== next) onCommit(next / 100, "pointer");
      }}
      className="flex w-14 shrink-0"
    >
      <NumberField.ScrubArea
        data-tuned={tuned === true ? "" : undefined}
        className="flex h-6 w-full cursor-ew-resize items-center gap-0.5 ps-2 pe-1.5 select-none has-focus:cursor-text"
        onPointerDown={() => {
          pressedAt.current = percent;
        }}
      >
        <NumberField.Input
          aria-label={`${label} opacity`}
          className="h-5 w-full min-w-0 cursor-[inherit] bg-transparent text-start text-meta tabular-nums text-foreground outline-none in-data-tuned:text-live focus:cursor-text"
        />
        <span className="shrink-0 text-meta text-muted-foreground">%</span>
      </NumberField.ScrubArea>
    </NumberField.Root>
  );
}
