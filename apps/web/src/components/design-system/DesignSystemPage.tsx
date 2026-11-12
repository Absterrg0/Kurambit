// Adapted from T3 Code's redesign catalog (MIT, Copyright (c) T3 Tools Inc.).
import {
  CopyIcon,
  FolderOpenIcon,
  GamepadIcon,
  ImagesIcon,
  PlayIcon,
  RotateCcwIcon,
  Settings2Icon,
  Trash2Icon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { useTheme } from "../../hooks/useTheme";
import { Badge } from "../ui/badge";
import { Button, type ButtonSize, type ButtonVariant } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Input } from "../ui/input";
import { Kbd, KbdGroup } from "../ui/kbd";
import { LabeledSection } from "../ui/labeled-section";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Radio, RadioGroup } from "../ui/radio-group";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { StatusDot, type StatusDotTone } from "../ui/status-dot";
import { Switch } from "../ui/switch";
import { Text } from "../ui/text";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Every primitive on one page, live, in the current theme. Switch the
 * appearance at the top to check the other one. Screens are built from these:
 * a new need becomes a variant here, not a one-off style. Dev builds only.
 */
export function DesignSystemPage() {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-16 px-6 pt-6 pb-24">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Text variant="body" tone="muted" render={<p className="max-w-2xl" />}>
            Every primitive, live. Vermilion marks only what is live; the primary action is a plain
            light fill in dark and a dark fill in light.
          </Text>
          <AppearanceSwitch />
        </div>
        <FoundationsSection />
        <SurfacesSection />
        <ButtonsSection />
        <FieldsSection />
        <ControlsSection />
        <OverlaysSection />
        <StatusSection />
        <StructureSection />
      </div>
    </ScrollArea>
  );
}

function AppearanceSwitch() {
  const { appearanceMode, setAppearanceMode } = useTheme();
  return (
    <ToggleGroup
      aria-label="Appearance"
      variant="segmented"
      value={[appearanceMode]}
      onValueChange={(next) => {
        const mode = next[0];
        if (mode === "light" || mode === "dark" || mode === "system") setAppearanceMode(mode);
      }}
    >
      <Toggle value="light">Light</Toggle>
      <Toggle value="dark">Dark</Toggle>
      <Toggle value="system">System</Toggle>
    </ToggleGroup>
  );
}

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="flex scroll-mt-6 flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <Text variant="title" tone="strong" render={<h2 />}>
          {title}
        </Text>
        <Text variant="body" tone="muted" render={<p className="max-w-3xl" />}>
          {description}
        </Text>
      </div>
      <div className="flex flex-col gap-8">{children}</div>
    </section>
  );
}

/** One labelled specimen. `source` names what to import. */
function Specimen({
  label,
  source,
  stack = false,
  grid = false,
  children,
}: {
  label: string;
  source?: string;
  stack?: boolean;
  /** Fixed 80px columns, so swatch spacing doesn't follow caption width. */
  grid?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <Text variant="meta" tone="muted">
          {label}
        </Text>
        {source ? (
          <Text variant="caption" tone="dim" mono>
            {source}
          </Text>
        ) : null}
      </div>
      <div
        className={
          stack
            ? "flex flex-col items-start gap-3"
            : grid
              ? "grid grid-cols-[repeat(auto-fill,5rem)] gap-x-3 gap-y-4"
              : "flex flex-wrap items-center gap-3"
        }
      >
        {children}
      </div>
    </div>
  );
}

function Caption({ children }: { children: ReactNode }) {
  return (
    <Text variant="caption" tone="dim" mono>
      {children}
    </Text>
  );
}

function Cell({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-1.5">
      {children}
      <Caption>{caption}</Caption>
    </div>
  );
}

/* Foundations */

const COLOR_TOKENS = [
  ["background", "bg-background"],
  ["card", "bg-card"],
  ["popover", "bg-popover"],
  ["muted", "bg-muted"],
  ["accent", "bg-accent"],
  ["sidebar", "bg-sidebar"],
  ["primary", "bg-primary"],
  ["live", "bg-live"],
  ["success", "bg-success"],
  ["warning", "bg-warning"],
  ["destructive", "bg-destructive"],
  ["info", "bg-info"],
  ["border", "bg-border"],
  ["ring", "bg-ring"],
] as const;

const TEXT_TIERS = [
  ["strong", "Strong: titles and the current row"],
  ["default", "Default: body text and labels"],
  ["muted", "Muted: descriptions and section labels (4.5:1)"],
  ["dim", "Dim: timestamps and separators only (3.5:1)"],
] as const;

const TYPE_ROLES = [
  ["title", "Title 22/600: page titles"],
  ["prompt", "Prompt 14/400: typed text"],
  ["label", "Label 14/500: buttons, menus, row titles"],
  ["body", "Body 14/400: descriptions and copy"],
  ["meta", "Meta 12/500: chips, metadata, small headings"],
  ["caption", "Caption 11/500: key hints and status"],
  ["micro", "Micro 10/500: counters in tight chrome"],
] as const;

const RADII = [
  ["sm", "rounded-sm"],
  ["md", "rounded-md"],
  ["lg", "rounded-lg"],
  ["xl", "rounded-xl"],
  ["2xl", "rounded-2xl"],
] as const;

function FoundationsSection() {
  return (
    <Section
      id="foundations"
      title="Foundations"
      description="Palette tokens, the four text tiers and the seven type roles. Colour on screen belongs to the games; the interface stays grey."
    >
      <Specimen label="Colour tokens" source="bg-{token}" grid>
        {COLOR_TOKENS.map(([name, className]) => (
          <Cell key={name} caption={name}>
            {/* An inset rim on every swatch, so one that matches the page still shows. */}
            <span
              className={`block size-12 rounded-lg ring-1 ring-strong-foreground/14 ring-inset ${className}`}
            />
          </Cell>
        ))}
      </Specimen>
      <Specimen label="Text tiers" source='<Text tone="…">' stack>
        {TEXT_TIERS.map(([tone, sample]) => (
          <Text key={tone} variant="body" tone={tone}>
            {sample}
          </Text>
        ))}
      </Specimen>
      <Specimen label="Type roles" source='<Text variant="…">' stack>
        {TYPE_ROLES.map(([variant, sample]) => (
          <Text key={variant} variant={variant}>
            {sample}
          </Text>
        ))}
      </Specimen>
      <Specimen label="Radii" source="rounded-{size}">
        {RADII.map(([name, className]) => (
          <Cell key={name} caption={name}>
            <span className={`block size-12 surface-raised ${className}`} />
          </Cell>
        ))}
      </Specimen>
      <MotionSpecimen />
    </Section>
  );
}

const MOTION_TOKENS = [
  ["--motion-fast", "150ms", "hover, press and colour changes (every transition-*)"],
  ["--motion-popup", "150ms in · 100ms out", "menus, selects, popovers, tooltips (motion-popup)"],
  [
    "--motion-surface",
    "200ms in · 150ms out",
    "dialogs, sheets, the settings panel (motion-surface)",
  ],
  ["--ease-enter / --ease-exit", "decelerate in · accelerate out", "every popup and surface"],
] as const;

/** Each sample runs once per click, the only way motion runs in the app. */
function MotionSpecimen() {
  const [shown, setShown] = useState(true);
  return (
    <Specimen label="Motion" source="motion-popup · motion-surface" stack>
      <div className="grid grid-cols-[auto_auto_1fr] gap-x-6 gap-y-1.5">
        {MOTION_TOKENS.map(([token, value, use]) => (
          <div key={token} className="contents">
            <Caption>{token}</Caption>
            <Text variant="meta">{value}</Text>
            <Text variant="meta" tone="muted">
              {use}
            </Text>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-6">
        <Button variant="secondary" size="sm" onClick={() => setShown((value) => !value)}>
          {shown ? "Close" : "Open"}
        </Button>
        {(["motion-popup", "motion-surface"] as const).map((motion) => (
          <Cell key={motion} caption={motion}>
            <span
              data-ending-style={shown ? undefined : ""}
              className={`block h-12 w-20 rounded-lg surface-popover transition-[scale,opacity] ${motion} data-ending-style:scale-98 data-ending-style:opacity-0`}
            />
          </Cell>
        ))}
      </div>
      <Caption>Reduced motion sets every token to 0ms.</Caption>
    </Specimen>
  );
}

/* Surfaces */

const SURFACES = [
  ["surface-raised", "surface-raised", "Secondary buttons, select triggers"],
  ["surface-lit", "surface-lit", "The primary action"],
  ["surface-well", "surface-well", "Fields and tracks"],
  ["surface-well-switch", "surface-well-switch", "An off switch's track"],
  ["surface-popover", "surface-popover", "Menus and popovers"],
  ["surface-tooltip", "surface-tooltip", "Tooltips"],
  ["surface-card-settings", "surface-card-settings", "Settings groups, in-flow cards"],
  ["surface-tray", "surface-tray", "What attaches around the composer"],
  ["surface-ghost-hover", "surface-ghost-hover", "A ghost control under the pointer"],
  ["surface-selected", "surface-selected", "The current row of a list"],
  ["surface-selected-soft", "surface-selected-soft", "A menu row's highlight"],
  ["surface-kbd", "surface-kbd", "A standalone key hint"],
] as const;

const TINTS = [
  ["success", "[--surface-tint:var(--success-foreground)] text-success-foreground"],
  ["warning", "[--surface-tint:var(--warning-foreground)] text-warning-foreground"],
  ["danger", "[--surface-tint:var(--destructive-foreground)] text-destructive-foreground"],
  ["info", "[--surface-tint:var(--info-foreground)] text-info-foreground"],
] as const;

function SurfacesSection() {
  return (
    <Section
      id="surfaces"
      title="Surfaces"
      description="Named recipes: a fill, a gradient rim and a shadow, derived from the palette so every theme gets them. Components pick a recipe instead of mixing bg, border and shadow by hand."
    >
      <Specimen label="Recipes" source="index.css @utility surface-*">
        <div className="grid w-full grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {SURFACES.map(([name, className, use]) => (
            <div key={name} className="flex flex-col gap-2">
              <div className={`h-16 rounded-lg ${className}`} />
              <Caption>{name}</Caption>
              <Text variant="caption" tone="muted">
                {use}
              </Text>
            </div>
          ))}
        </div>
      </Specimen>
      <Specimen label="States of a rimmed field" source="surface-focus · surface-invalid">
        <Cell caption="rest">
          <div className="h-9 w-40 rounded-lg surface-well" />
        </Cell>
        <Cell caption="surface-focus">
          <div className="h-9 w-40 rounded-lg surface-well surface-focus" />
        </Cell>
        <Cell caption="surface-invalid">
          <div className="h-9 w-40 rounded-lg surface-well surface-invalid" />
        </Cell>
        <Cell caption="surface-invalid-focus">
          <div className="h-9 w-40 rounded-lg surface-well surface-invalid-focus" />
        </Cell>
      </Specimen>
      <Specimen label="Tints" source="surface-tint [--surface-tint:…]">
        {TINTS.map(([name, className]) => (
          <div key={name} className={`rounded-lg px-3 py-1.5 surface-tint ${className}`}>
            <Text variant="meta" tone="inherit">
              {name}
            </Text>
          </div>
        ))}
      </Specimen>
      <Specimen label="Sidebar rows" source="surface-sidebar-row-selected">
        <div
          data-app-sidebar
          className="flex w-64 flex-col gap-0.5 rounded-xl border border-sidebar-border bg-sidebar p-2"
        >
          <div className="flex h-8 items-center rounded-md px-2.5 surface-sidebar-row-selected">
            <Text variant="label" tone="inherit">
              Fox Dash
            </Text>
          </div>
          <div className="flex h-8 items-center rounded-md px-2.5 hover:bg-sidebar-row-hover">
            <Text variant="label" tone="muted">
              Paper Boat Gutter
            </Text>
          </div>
          <div className="flex h-8 items-center rounded-md px-2.5">
            <Text variant="caption" tone="dim">
              Games
            </Text>
          </div>
        </div>
      </Specimen>
    </Section>
  );
}

/* Buttons */

const MATRIX_VARIANTS = [
  ["default", "Build it"],
  ["secondary", "Compare"],
  ["destructive", "Delete"],
  ["destructive-outline", "Undo this build"],
  ["ghost", "Ghost"],
  ["ghost-muted", "Ghost muted"],
  ["warning-outline", "Look at this"],
] as const satisfies ReadonlyArray<readonly [ButtonVariant, string]>;

const BUTTON_SIZES = [
  "micro",
  "xs",
  "compact",
  "sm",
  "default",
  "lg",
] as const satisfies ReadonlyArray<ButtonSize>;
const ICON_SIZES = [
  "icon-micro",
  "icon-xs",
  "icon-sm",
  "icon",
] as const satisfies ReadonlyArray<ButtonSize>;

function ButtonsSection() {
  return (
    <Section
      id="buttons"
      title="Buttons"
      description="Primary is lit, secondary is raised, ghost has no surface until the pointer is on it. outline is the same raised recipe as secondary."
    >
      <Specimen label="Variants × states" source="<Button variant>">
        <div className="grid grid-cols-[auto_repeat(5,auto)] items-center gap-x-4 gap-y-3">
          <span />
          {["rest", "hover / pressed", "focus", "disabled", "busy"].map((state) => (
            <Caption key={state}>{state}</Caption>
          ))}
          {MATRIX_VARIANTS.map(([variant, label]) => (
            <ButtonStateRow key={variant} variant={variant} label={label} />
          ))}
        </div>
      </Specimen>
      <Specimen label="Sizes" source="<Button size>">
        {BUTTON_SIZES.map((size) => (
          <Cell key={size} caption={size}>
            <Button size={size} variant="secondary">
              <PlayIcon />
              Play
            </Button>
          </Cell>
        ))}
      </Specimen>
      <Specimen label="Icon buttons" source='size="icon-*"'>
        {ICON_SIZES.map((size) => (
          <Cell key={size} caption={size}>
            <Button size={size} variant="ghost" aria-label="Settings">
              <Settings2Icon />
            </Button>
          </Cell>
        ))}
      </Specimen>
      <Specimen label="Key hint inside a control" source="<Button><Kbd /></Button>">
        <Button>
          Start building
          <Kbd>⏎</Kbd>
        </Button>
        <Button variant="secondary">
          Skip
          <Kbd>Esc</Kbd>
        </Button>
        <Button variant="destructive">
          Delete
          <Kbd>⌫</Kbd>
        </Button>
      </Specimen>
    </Section>
  );
}

function ButtonStateRow({ variant, label }: { variant: ButtonVariant; label: string }) {
  return (
    <>
      <Caption>{variant}</Caption>
      <Button variant={variant} size="sm">
        {label}
      </Button>
      <Button variant={variant} size="sm" data-pressed="">
        {label}
      </Button>
      <Button variant={variant} size="sm" data-focus-preview="">
        {label}
      </Button>
      <Button variant={variant} size="sm" disabled>
        {label}
      </Button>
      <Button variant={variant} size="sm" disabled>
        <Spinner />
        {label}
      </Button>
    </>
  );
}

/* Fields */

const ENGINE_ITEMS = { threejs: "three.js", godot: "Godot", unity: "Unity" };

function FieldsSection() {
  const [engine, setEngine] = useState("threejs");
  return (
    <Section
      id="fields"
      title="Fields"
      description="Fields are wells: sunken, with a rim that becomes the ring on focus and the error colour when invalid. Typed text is the prompt role; placeholders hold 4:1."
    >
      <Specimen label="Input" source="<Input>">
        <Cell caption="placeholder">
          <Input className="w-56" placeholder="Name your game" />
        </Cell>
        <Cell caption="value">
          <Input className="w-56" defaultValue="Fox Dash" />
        </Cell>
        <Cell caption="invalid">
          <Input className="w-56" defaultValue="fox/dash" aria-invalid />
        </Cell>
        <Cell caption="disabled">
          <Input className="w-56" defaultValue="Read only" disabled />
        </Cell>
        <Cell caption="compact">
          <Input className="w-40" size="compact" placeholder="Filter" />
        </Cell>
      </Specimen>
      <Specimen label="Textarea" source="<Textarea>">
        <Textarea className="w-full max-w-md" placeholder="Tell your game what to change…" />
      </Specimen>
      <Specimen label="Select" source="<Select> <SelectTrigger>">
        <Select
          value={engine}
          items={ENGINE_ITEMS}
          onValueChange={(value) => {
            if (typeof value === "string") setEngine(value);
          }}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {Object.entries(ENGINE_ITEMS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Select value={engine} items={ENGINE_ITEMS} disabled>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
        </Select>
      </Specimen>
    </Section>
  );
}

/* Controls */

function ControlsSection() {
  const [sound, setSound] = useState(true);
  const [music, setMusic] = useState(false);
  const [view, setView] = useState("build");
  return (
    <Section
      id="controls"
      title="Controls"
      description="An off switch is a sunken track with a muted thumb, so it reads as a control at rest. Unchecked boxes carry a muted rim on every surface."
    >
      <Specimen label="Switch" source="<Switch>">
        <Cell caption="on">
          <Switch checked={sound} onCheckedChange={setSound} aria-label="Sound" />
        </Cell>
        <Cell caption="off">
          <Switch checked={music} onCheckedChange={setMusic} aria-label="Music" />
        </Cell>
        <Cell caption="mixed">
          <Switch mixed aria-label="Some" />
        </Cell>
        <Cell caption="disabled">
          <Switch disabled aria-label="Disabled" />
        </Cell>
        <Cell caption="sm">
          <Switch size="sm" defaultChecked aria-label="Small" />
        </Cell>
        <Cell caption="on a card">
          <div className="flex items-center gap-3 rounded-xl px-4 py-3 surface-card-settings">
            <Switch aria-label="Off on a card" />
            <Text variant="meta" tone="muted">
              Off
            </Text>
          </div>
        </Cell>
      </Specimen>
      <Specimen label="Checkbox" source="<Checkbox>">
        <Cell caption="unchecked">
          <Checkbox aria-label="Unchecked" />
        </Cell>
        <Cell caption="checked">
          <Checkbox defaultChecked aria-label="Checked" />
        </Cell>
        <Cell caption="indeterminate">
          <Checkbox indeterminate aria-label="Indeterminate" />
        </Cell>
        <Cell caption="invalid">
          <Checkbox aria-invalid aria-label="Invalid" />
        </Cell>
        <Cell caption="disabled">
          <Checkbox disabled aria-label="Disabled" />
        </Cell>
      </Specimen>
      <Specimen label="Radio" source="<RadioGroup> <Radio>">
        <RadioGroup defaultValue="smooth" aria-label="Shading">
          <Radio value="smooth" aria-label="Smooth" />
          <Radio value="flat" aria-label="Flat" />
          <Radio value="toon" disabled aria-label="Toon" />
        </RadioGroup>
      </Specimen>
      <Specimen label="Segmented" source='<ToggleGroup variant="segmented">'>
        <ToggleGroup
          aria-label="Inspector tab"
          value={[view]}
          onValueChange={(next) => {
            if (next[0]) setView(next[0]);
          }}
        >
          <Toggle value="build">Build</Toggle>
          <Toggle value="scene">Scene</Toggle>
          <Toggle value="log">Log</Toggle>
        </ToggleGroup>
      </Specimen>
    </Section>
  );
}

/* Menus, popovers, tooltips, key hints */

function OverlaysSection() {
  const [effort, setEffort] = useState("medium");
  const [frozen, setFrozen] = useState(false);
  return (
    <Section
      id="overlays"
      title="Menus, popovers and tooltips"
      description="Every floating surface shares the popover recipe, keeps 8px from the window edge, and fades out where it was. Menu rows are concentric with their popup. A Kbd takes its colours from where it sits."
    >
      <Specimen label="Menu" source="<Menu> <MenuItem variant>">
        <Menu>
          <MenuTrigger render={<Button variant="secondary" />}>Stage</MenuTrigger>
          <MenuPopup align="start">
            <MenuGroup>
              <MenuGroupLabel>Effort</MenuGroupLabel>
              <MenuRadioGroup value={effort} onValueChange={setEffort}>
                <MenuRadioItem value="low">Low</MenuRadioItem>
                <MenuRadioItem value="medium">Medium</MenuRadioItem>
                <MenuRadioItem value="high">High</MenuRadioItem>
              </MenuRadioGroup>
            </MenuGroup>
            <MenuSeparator />
            <MenuCheckboxItem variant="switch" checked={frozen} onCheckedChange={setFrozen}>
              Freeze the Stage
            </MenuCheckboxItem>
            <MenuSeparator />
            <MenuItem>
              <RotateCcwIcon />
              Reload
              <MenuShortcut>Ctrl+R</MenuShortcut>
            </MenuItem>
            <MenuSub>
              <MenuSubTrigger>
                <ImagesIcon />
                Generated art
              </MenuSubTrigger>
              <MenuSubPopup>
                <MenuItem>Characters</MenuItem>
                <MenuItem>Props</MenuItem>
              </MenuSubPopup>
            </MenuSub>
            <MenuItem disabled>
              <CopyIcon />
              Copy build link
            </MenuItem>
            <MenuItem variant="destructive">
              <Trash2Icon />
              Delete game
            </MenuItem>
          </MenuPopup>
        </Menu>
      </Specimen>
      <Specimen label="Popover" source="<Popover> <PopoverPopup>">
        <Popover>
          <PopoverTrigger render={<Button variant="secondary" />}>Open popover</PopoverTrigger>
          <PopoverPopup width="sm">
            <div className="flex flex-col gap-2">
              <PopoverTitle>Export</PopoverTitle>
              <Text variant="body" tone="muted" render={<p />}>
                A web build of the game, ready to upload.
              </Text>
              <Button size="sm">
                Export
                <Kbd>⏎</Kbd>
              </Button>
            </div>
          </PopoverPopup>
        </Popover>
      </Specimen>
      <Specimen label="Tooltip" source="<Tooltip> <TooltipPopup variant>">
        {(["default", "glass", "code"] as const).map((variant) => (
          <Tooltip key={variant}>
            <TooltipTrigger render={<Button variant="secondary" size="sm" />}>
              {variant}
            </TooltipTrigger>
            <TooltipPopup variant={variant}>
              {variant === "code" ? "~/games/fox-dash/game.json" : "Freeze to point at things"}{" "}
              {variant === "default" ? <Kbd>Tab</Kbd> : null}
            </TooltipPopup>
          </Tooltip>
        ))}
      </Specimen>
      <Specimen label="Key hints" source="<Kbd> <KbdGroup>">
        <Cell caption="standalone">
          <Kbd>Tab</Kbd>
        </Cell>
        <Cell caption="group">
          <KbdGroup>
            <Kbd>Ctrl</Kbd>
            <Kbd>K</Kbd>
          </KbdGroup>
        </Cell>
        <Cell caption="in a popup">
          <div className="kbd-in-popover rounded-lg px-3 py-2 surface-popover">
            <KbdGroup>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
            </KbdGroup>
          </div>
        </Cell>
      </Specimen>
    </Section>
  );
}

/* Status */

const DOT_TONES = [
  "neutral",
  "live",
  "success",
  "warning",
  "danger",
  "info",
  "foreground",
] as const satisfies ReadonlyArray<StatusDotTone>;

const BADGE_VARIANTS = [
  "default",
  "secondary",
  "outline",
  "success",
  "warning",
  "error",
  "info",
] as const;

function StatusSection() {
  return (
    <Section
      id="status"
      title="Status and loading"
      description="Status dots carry a tone; live (vermilion) is only for an agent at work or a build being made. Loading keeps final sizes so nothing shifts."
    >
      <Specimen label="Status dots" source="<StatusDot tone size>">
        {DOT_TONES.map((tone) => (
          <Cell key={tone} caption={tone}>
            <div className="flex items-center gap-3">
              <StatusDot tone={tone} />
              <StatusDot tone={tone} size="md" />
            </div>
          </Cell>
        ))}
      </Specimen>
      <Specimen label="Live and labelled" source="pulse · ping · label">
        <Cell caption="pulse">
          <StatusDot tone="live" pulse />
        </Cell>
        <Cell caption="ping">
          <StatusDot tone="live" ping />
        </Cell>
        <Cell caption="label (tooltip)">
          <StatusDot tone="success" label="Checks pass" />
        </Cell>
        <Cell caption="beside text">
          <span className="flex items-center gap-1.5">
            <StatusDot tone="warning" />
            <Text variant="meta" tone="muted">
              2 to look at
            </Text>
          </span>
        </Cell>
      </Specimen>
      <Specimen label="Badges" source="<Badge variant>">
        {BADGE_VARIANTS.map((variant) => (
          <Badge key={variant} variant={variant}>
            {variant}
          </Badge>
        ))}
      </Specimen>
      <Specimen label="Loading" source="<Spinner> <Skeleton>">
        <Spinner size="md" tone="muted" />
        <div className="flex w-56 flex-col gap-2">
          <Skeleton shape="card" className="h-24 w-full" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      </Specimen>
    </Section>
  );
}

/* Structure */

function StructureSection() {
  return (
    <Section
      id="structure"
      title="Sections and empty states"
      description="LabeledSection owns one heading size and the gap under it. An empty state says what goes there and points at how to fill it."
    >
      <Specimen label="Labeled section" source="<LabeledSection label action>">
        <div className="w-80">
          <LabeledSection
            label="Checks · 5 of 6 pass"
            action={
              <Button size="icon-xs" variant="ghost" aria-label="Measure again">
                <RotateCcwIcon />
              </Button>
            }
          >
            <div className="flex flex-col gap-1">
              {["Boots", "Can be won", "Holds 60 fps"].map((check) => (
                <div key={check} className="flex h-8 items-center gap-2">
                  <StatusDot tone="success" />
                  <Text variant="label">{check}</Text>
                </div>
              ))}
            </div>
          </LabeledSection>
        </div>
      </Specimen>
      <Specimen label="Empty state" source="<Empty> <EmptyMedia> <EmptyTitle>">
        <div className="w-full max-w-md rounded-xl surface-card-settings">
          <Empty size="compact">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <GamepadIcon />
              </EmptyMedia>
              <EmptyTitle>No builds yet</EmptyTitle>
              <EmptyDescription>
                Each change your agent makes to the game becomes a build you can play.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="secondary" size="sm">
                <FolderOpenIcon />
                Open a game
              </Button>
            </EmptyContent>
          </Empty>
        </div>
      </Specimen>
    </Section>
  );
}
