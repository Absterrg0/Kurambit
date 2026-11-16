import { useState } from "react";

import { hexToHsv, hsvToHex, type HsvColor } from "../../lib/color";
import { Button } from "../ui/button";
import { ColorHueSlider, ColorSaturationValuePlane } from "../ui/color-picker";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

/** A colour as the game keeps it, 0xRRGGBB, as "#rrggbb" and back. */
export const colourHex = (value: number) =>
  `#${Math.max(0, Math.min(0xffffff, Math.round(value)))
    .toString(16)
    .padStart(6, "0")}`;
const colourNumber = (hex: string) => Number.parseInt(hex.slice(1), 16);

/**
 * A colour value: its swatch and hex as a ghost button that opens a picker. It changes the game as
 * the picker moves (`onChange`) and keeps the colour when a drag ends or a typed hex is whole
 * (`onCommit`), the way a tuned number does.
 */
export function GameColourField({
  label,
  value,
  disabled,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  disabled: boolean;
  onChange: (next: number) => void;
  onCommit: (next: number) => void;
}) {
  const hex = colourHex(value);
  const [hsv, setHsv] = useState<HsvColor>(() => hexToHsv(hex));
  const [draft, setDraft] = useState<string | null>(null);
  // A value that changed from outside (a reset, the Stage) moves the picker with it.
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
    <Popover>
      <PopoverTrigger
        disabled={disabled}
        render={<Button size="xs" variant="ghost" aria-label={`${label}: ${hex}`} />}
      >
        <span
          aria-hidden="true"
          className="size-3.5 rounded-sm ring-1 ring-border ring-inset"
          style={{ backgroundColor: hex }}
        />
        <span className="tabular-nums">{hex.toUpperCase()}</span>
      </PopoverTrigger>
      <PopoverPopup side="left" align="start" sideOffset={6} padding="none">
        <div className="w-56">
          <ColorSaturationValuePlane
            label={label}
            value={hsv}
            onChange={move}
            onInteractionEnd={keep}
            variant="edge"
          />
          <div className="grid gap-3 p-3">
            <ColorHueSlider
              label={`${label} hue`}
              value={hsv.h}
              onChange={(h) => move({ ...hsv, h })}
              onInteractionEnd={keep}
            />
            <Input
              nativeInput
              size="compact"
              value={draft ?? hex}
              onChange={(event) => {
                const typed = event.currentTarget.value.trim();
                setDraft(typed);
                if (!/^#[\da-f]{6}$/i.test(typed)) return;
                setHsv(hexToHsv(typed));
                onChange(colourNumber(typed));
                onCommit(colourNumber(typed));
              }}
              onBlur={() => setDraft(null)}
              aria-label={`${label} as hex`}
              spellCheck={false}
            />
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
