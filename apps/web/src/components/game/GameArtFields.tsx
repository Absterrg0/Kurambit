import { useState } from "react";

import { Input } from "../ui/input";
import { PropertyReading, PropertyRow } from "../ui/property-field";
import type { useTuneSaver } from "./GameTune";
import { nameStageThing } from "./gameStageBridge";

type TuneSaver = ReturnType<typeof useTuneSaver>;

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
