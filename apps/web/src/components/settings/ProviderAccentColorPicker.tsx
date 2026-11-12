"use client";

import { XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { hexToHsv, hsvToHex, type HsvColor } from "../../lib/color";
import { ColorHueSlider, ColorSaturationValuePlane } from "../ui/color-picker";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { normalizeProviderAccentColor } from "../../providerInstances";

const FALLBACK_ACCENT_COLOR = "#2563eb";

function ProviderCustomColorPanel(props: {
  readonly value: string;
  readonly onCommit: (value: string) => void;
}) {
  const { onCommit } = props;
  const [hsv, setHsv] = useState(() => hexToHsv(props.value));
  const currentColor = hsvToHex(hsv.h, hsv.s, hsv.v);
  const [hexDraft, setHexDraft] = useState<string | null>(null);

  const commitHsv = (nextHsv: HsvColor) => {
    setHsv(nextHsv);
    onCommit(hsvToHex(nextHsv.h, nextHsv.s, nextHsv.v));
  };

  return (
    <div className="w-56 bg-popover">
      <ColorSaturationValuePlane
        label="Accent colour"
        value={hsv}
        onChange={commitHsv}
        variant="edge"
      />
      <div className="grid gap-3 p-3">
        <ColorHueSlider
          label="Accent colour hue"
          value={hsv.h}
          onChange={(h) => commitHsv({ ...hsv, h })}
        />
        <Input
          nativeInput
          size="compact"
          value={hexDraft ?? currentColor}
          onChange={(event) => {
            const nextColor = event.currentTarget.value;
            setHexDraft(nextColor);
            if (!/^#[\da-f]{6}$/i.test(nextColor)) return;
            setHsv(hexToHsv(nextColor));
            props.onCommit(nextColor);
          }}
          onBlur={() => setHexDraft(null)}
          font="mono"
          aria-label="Custom hex accent colour"
          spellCheck={false}
        />
      </div>
    </div>
  );
}

function ProviderCustomColorPicker(props: {
  readonly displayName: string;
  readonly value: string | undefined;
  readonly onCommit: (value: string) => void;
  readonly onClear: () => void;
}) {
  const normalized = normalizeProviderAccentColor(props.value);

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  size="sm"
                  variant="ghost-muted"
                  aria-label={`${normalized ? "Change" : "Add"} accent colour for ${props.displayName}`}
                >
                  {/* A colour well with its name: a bare ring beside the name field
                      read as a stray control. */}
                  <span
                    aria-hidden
                    className={
                      normalized
                        ? "size-3.5 rounded-full ring-1 ring-strong-foreground/20 ring-inset"
                        : "size-3.5 rounded-full ring-1 ring-muted-foreground/60 ring-inset"
                    }
                    style={normalized ? { backgroundColor: normalized } : undefined}
                  />
                  {/* The row is already titled Colour; the button says which one. */}
                  {normalized ? normalized.toUpperCase() : "None"}
                </Button>
              }
            />
          }
        />
        <TooltipPopup side="top">Accent colour</TooltipPopup>
      </Tooltip>
      <PopoverPopup side="bottom" align="start" sideOffset={6} padding="none">
        <ProviderCustomColorPanel
          value={normalized ?? FALLBACK_ACCENT_COLOR}
          onCommit={props.onCommit}
        />
        {normalized ? (
          <div className="border-t border-border/60 p-1">
            <PopoverClose
              render={
                <Button
                  type="button"
                  size="compact"
                  variant="ghost-muted"
                  className="w-full justify-start"
                  onClick={props.onClear}
                >
                  <XIcon className="size-3.5" aria-hidden />
                  Clear colour
                </Button>
              }
            />
          </div>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

export function ProviderAccentColorPicker(props: {
  readonly displayName: string;
  readonly value: string | undefined;
  readonly onCommit: (value: string) => void;
  readonly description?: string;
  readonly commitDelayMs?: number;
  readonly layout?: "stacked" | "inline";
}) {
  const {
    commitDelayMs = 0,
    description,
    displayName,
    layout = "stacked",
    onCommit,
    value,
  } = props;
  const [optimisticValue, setOptimisticValue] = useState(() => value ?? "");
  const commitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCommitRef = useRef<string | null>(null);
  const onCommitRef = useRef(onCommit);

  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  useEffect(() => {
    if (pendingCommitRef.current !== null) return;
    setOptimisticValue(value ?? "");
  }, [value]);

  useEffect(() => {
    return () => {
      if (commitTimeoutRef.current !== null) {
        clearTimeout(commitTimeoutRef.current);
      }
      const pendingCommit = pendingCommitRef.current;
      if (pendingCommit !== null) {
        onCommitRef.current(pendingCommit);
      }
    };
  }, []);

  const commitAccentColor = (value: string) => {
    const normalizedValue = normalizeProviderAccentColor(value) ?? "";
    setOptimisticValue(normalizedValue);

    if (commitDelayMs <= 0) {
      pendingCommitRef.current = null;
      if (commitTimeoutRef.current !== null) {
        clearTimeout(commitTimeoutRef.current);
        commitTimeoutRef.current = null;
      }
      onCommit(normalizedValue);
      return;
    }

    pendingCommitRef.current = normalizedValue;
    if (commitTimeoutRef.current !== null) {
      clearTimeout(commitTimeoutRef.current);
    }
    commitTimeoutRef.current = setTimeout(() => {
      commitTimeoutRef.current = null;
      const pendingCommit = pendingCommitRef.current;
      pendingCommitRef.current = null;
      if (pendingCommit !== null) {
        onCommitRef.current(pendingCommit);
      }
    }, commitDelayMs);
  };

  const normalized = normalizeProviderAccentColor(optimisticValue);
  const picker = (
    <ProviderCustomColorPicker
      displayName={displayName}
      value={normalized}
      onCommit={commitAccentColor}
      onClear={() => commitAccentColor("")}
    />
  );

  if (layout === "inline") {
    return picker;
  }

  return (
    <div className="grid gap-2">
      <span className="text-xs font-medium text-foreground">Accent color</span>
      {picker}
      {description ? <span className="text-xs text-muted-foreground">{description}</span> : null}
    </div>
  );
}
