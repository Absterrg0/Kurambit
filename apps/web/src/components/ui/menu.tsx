"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import type * as React from "react";
import { useId } from "react";

import { cn } from "~/lib/utils";
import { buttonVariants } from "./button";
import { POPUP_COLLISION_PADDING, renderClosingPositioner } from "./closing-positioner";
import { tooltipSafeFinalFocus } from "./focus-return";
import { MENU_ROW_TEXT_CLASS } from "./menu-row-text";
import { KbdShortcut } from "./kbd";
import { RELAXED_PICKER_CLASS } from "./picker-styles";

// Rows are concentric with the popup: their radius is the popup's minus its 1px
// rim and 4px padding. The highlight is the soft selected fill, so a row under
// the pointer reads as a place in the list, not a pressed button.
const ROW_BASE_CLASS = `cursor-pointer rounded-[var(--popup-item-radius,7px)] ${MENU_ROW_TEXT_CLASS} text-foreground outline-none data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-highlighted:surface-selected-soft data-highlighted:text-strong-foreground data-highlighted:active:surface-selected data-disabled:opacity-45 sm:min-h-7`;

const Menu = MenuPrimitive.Root;

function MenuTrigger({ className, children, ...props }: MenuPrimitive.Trigger.Props) {
  return (
    <MenuPrimitive.Trigger className={className} data-slot="menu-trigger" {...props}>
      {children}
    </MenuPrimitive.Trigger>
  );
}

function MenuPopup({
  children,
  className,
  sideOffset = 4,
  align = "center",
  alignOffset,
  side = "bottom",
  anchor,
  keepMounted = false,
  spacing = "default",
  ...props
}: MenuPrimitive.Popup.Props & {
  align?: MenuPrimitive.Positioner.Props["align"];
  sideOffset?: MenuPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: MenuPrimitive.Positioner.Props["alignOffset"];
  side?: MenuPrimitive.Positioner.Props["side"];
  anchor?: MenuPrimitive.Positioner.Props["anchor"];
  keepMounted?: boolean;
  /** `relaxed` is the denser picker look (picker-styles.ts). */
  spacing?: "default" | "relaxed";
}) {
  const defaultId = useId();
  const popupId = props.id ?? defaultId;
  return (
    <MenuPrimitive.Portal keepMounted={keepMounted}>
      <MenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        className="z-[130]"
        collisionPadding={POPUP_COLLISION_PADDING}
        data-slot="menu-positioner"
        render={renderClosingPositioner}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          className={cn(
            "surface-popover kbd-in-popover relative flex origin-(--transform-origin) rounded-lg outline-none focus:outline-none transition-[scale,opacity] motion-popup data-starting-style:scale-98 data-starting-style:opacity-0 data-ending-style:scale-98 data-ending-style:opacity-0",
            spacing === "relaxed" && RELAXED_PICKER_CLASS,
            // Portaled menus can overlap an Electron window drag region (e.g.
            // the Review panel header). Drag hit-testing ignores z-index, so
            // the topmost row would stay unhoverable without this opt-out.
            "[-webkit-app-region:no-drag]",
            "min-w-[min(10rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)]",
            className,
          )}
          data-slot="menu-popup"
          {...props}
          id={popupId}
          finalFocus={tooltipSafeFinalFocus(props.finalFocus, popupId)}
        >
          <div className="max-h-(--available-height) w-full overflow-y-auto p-1 [--popup-item-radius:calc(var(--radius-lg)-5px)]">
            {children}
          </div>
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function MenuGroup(props: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="menu-group" {...props} />;
}

function MenuItem({
  className,
  inset,
  density = "default",
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & {
  inset?: boolean;
  density?: "default" | "touch";
  variant?: "default" | "destructive" | "ghost";
}) {
  return (
    <MenuPrimitive.Item
      className={cn(
        ROW_BASE_CLASS,
        "[&>svg]:-mx-0.5 flex min-h-8 select-none items-center gap-2 px-2 py-1 data-inset:ps-8 data-[variant=destructive]:text-destructive-foreground data-highlighted:data-[variant=destructive]:text-destructive-foreground [&>svg:not([class*='size-'])]:size-4.5 sm:[&>svg:not([class*='size-'])]:size-4 [&>svg:not([class*='text-'])]:text-muted-foreground data-highlighted:[&>svg:not([class*='text-'])]:text-foreground data-[variant=destructive]:[&>svg:not([class*='text-'])]:text-current [&>svg]:pointer-events-none [&>svg]:shrink-0",
        variant === "ghost" &&
          buttonVariants({
            variant: "ghost",
            size: "compact",
            className: "h-auto min-h-7 w-full",
          }),
        density === "touch" && "min-h-10 sm:min-h-10",
        className,
      )}
      data-density={density}
      data-inset={inset}
      data-slot="menu-item"
      data-variant={variant}
      {...props}
    />
  );
}

function MenuItemLabel({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="menu-item-label"
      className={cn(
        "min-w-0 truncate in-data-[density=touch]:[text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:in-data-[density=touch]:py-[0.5em]",
        className,
      )}
      {...props}
    />
  );
}

function MenuCheckboxItem({
  className,
  children,
  checked,
  variant = "default",
  ...props
}: MenuPrimitive.CheckboxItem.Props & {
  variant?: "default" | "switch";
}) {
  return (
    <MenuPrimitive.CheckboxItem
      checked={checked}
      className={cn(
        ROW_BASE_CLASS,
        "grid min-h-8 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] items-center gap-2 py-1 ps-2 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        variant === "switch"
          ? "grid-cols-[1fr_auto] gap-4 pe-1.5"
          : "grid-cols-[1rem_minmax(0,1fr)] pe-4",
        className,
      )}
      data-slot="menu-checkbox-item"
      {...props}
    >
      {variant === "switch" ? (
        <>
          <span className="col-start-1">{children}</span>
          <MenuPrimitive.CheckboxItemIndicator
            className="inline-flex h-[calc(var(--thumb-size)+2px)] w-[calc(var(--thumb-size)*2-2px)] shrink-0 items-center rounded-full border border-transparent p-0 outline-none [--thumb-size:--spacing(4)] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring data-checked:surface-gloss-on data-unchecked:surface-well-switch data-disabled:opacity-64 sm:[--thumb-size:--spacing(3)]"
            keepMounted
          >
            <span className="pointer-events-none block aspect-square h-full in-[[data-slot=menu-checkbox-item][data-checked]]:origin-[var(--thumb-size)_50%] origin-left in-[[data-slot=menu-checkbox-item][data-checked]]:translate-x-[calc(var(--thumb-size)-4px)] in-[[data-slot=menu-checkbox-item]:active]:not-data-disabled:scale-x-110 in-[[data-slot=menu-checkbox-item]:active]:rounded-[var(--thumb-size)/calc(var(--thumb-size)*1.10)] rounded-(--thumb-size) surface-gloss-off-thumb in-[[data-slot=menu-checkbox-item][data-checked]]:surface-gloss-thumb [transition:translate_.15s,border-radius_.15s,scale_.1s_.1s,transform-origin_.15s]" />
          </MenuPrimitive.CheckboxItemIndicator>
        </>
      ) : (
        <>
          <MenuPrimitive.CheckboxItemIndicator className="col-start-1">
            <svg
              fill="none"
              height="24"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              viewBox="0 0 24 24"
              width="24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
            </svg>
          </MenuPrimitive.CheckboxItemIndicator>
          <span className="col-start-2">{children}</span>
        </>
      )}
    </MenuPrimitive.CheckboxItem>
  );
}

function MenuRadioGroup(props: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="menu-radio-group" {...props} />;
}

function MenuRadioItem({
  className,
  children,
  hideIndicator: _hideIndicator = false,
  ...props
}: MenuPrimitive.RadioItem.Props & {
  hideIndicator?: boolean;
}) {
  return (
    <MenuPrimitive.RadioItem
      className={cn(
        ROW_BASE_CLASS,
        "[&_svg]:-mx-0.5 flex min-h-8 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] items-center px-2 py-1 data-checked:surface-selected-soft data-checked:text-strong-foreground [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      data-slot="menu-radio-item"
      {...props}
    >
      <span className="min-w-0 flex-1">{children}</span>
    </MenuPrimitive.RadioItem>
  );
}

function MenuRadioItemIndicator({
  className,
  children,
  ...props
}: MenuPrimitive.RadioItemIndicator.Props) {
  return (
    <MenuPrimitive.RadioItemIndicator
      aria-hidden
      className={cn("flex shrink-0", className)}
      data-slot="menu-radio-item-indicator"
      {...props}
    >
      {children ?? <CheckIcon className="size-3.5" />}
    </MenuPrimitive.RadioItemIndicator>
  );
}

function MenuGroupLabel({
  className,
  inset,
  ...props
}: MenuPrimitive.GroupLabel.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.GroupLabel
      className={cn(
        "px-2 py-1.5 text-meta text-muted-foreground data-inset:ps-9 sm:data-inset:ps-8",
        className,
      )}
      data-inset={inset}
      data-slot="menu-label"
      {...props}
    />
  );
}

function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      className={cn("mx-2 my-1 h-px bg-border", className)}
      data-slot="menu-separator"
      {...props}
    />
  );
}

// Key chords only, drawn with the shared Kbd chips. A trailing value that is not a
// key (a snooze time, a count) is MenuItemDetail.
function MenuShortcut({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <KbdShortcut
      className={cn("ms-auto shrink-0 ps-4", className)}
      data-slot="menu-shortcut"
      {...props}
    />
  );
}

function MenuItemDetail({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn("ms-auto shrink-0 ps-4 text-meta text-secondary-label", className)}
      data-slot="menu-item-detail"
      {...props}
    />
  );
}

function MenuSub(props: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="menu-sub" {...props} />;
}

function MenuSubTrigger({
  className,
  inset,
  density = "default",
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean;
  density?: "default" | "touch";
}) {
  return (
    <MenuPrimitive.SubmenuTrigger
      className={cn(
        // Scoped away from the last child because the chevron is also a direct
        // svg — on a sub-trigger with no leading icon it is the only one, and
        // these rules would take away its `ms-auto` alignment.
        ROW_BASE_CLASS,
        "[&>svg:not(:last-child)]:-mx-0.5 flex min-h-8 items-center gap-2 px-2 py-1 data-popup-open:surface-selected-soft data-inset:ps-8 data-popup-open:text-strong-foreground [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground [&_svg]:pointer-events-none [&>svg]:shrink-0",
        density === "touch" && "min-h-10 sm:min-h-10",
        className,
      )}
      data-density={density}
      data-inset={inset}
      data-slot="menu-sub-trigger"
      {...props}
    >
      {children}
      <ChevronRightIcon className="-me-0.5 ms-auto size-3.5 text-muted-foreground" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

function MenuSubPopup({
  className,
  sideOffset = 0,
  alignOffset,
  align = "start",
  ...props
}: MenuPrimitive.Popup.Props & {
  align?: MenuPrimitive.Positioner.Props["align"];
  sideOffset?: MenuPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: MenuPrimitive.Positioner.Props["alignOffset"];
  /** A submenu of a `relaxed` picker passes it on; popups do not inherit it. */
  spacing?: "default" | "relaxed";
}) {
  const defaultAlignOffset = align !== "center" ? -5 : undefined;

  return (
    <MenuPopup
      align={align}
      alignOffset={alignOffset ?? defaultAlignOffset}
      className={className}
      data-slot="menu-sub-content"
      side="inline-end"
      sideOffset={sideOffset}
      {...props}
    />
  );
}

export {
  Menu,
  Menu as DropdownMenu,
  MenuTrigger,
  MenuTrigger as DropdownMenuTrigger,
  MenuPopup,
  MenuPopup as DropdownMenuContent,
  MenuGroup,
  MenuGroup as DropdownMenuGroup,
  MenuItem,
  MenuItemLabel,
  MenuItem as DropdownMenuItem,
  MenuCheckboxItem,
  MenuCheckboxItem as DropdownMenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioGroup as DropdownMenuRadioGroup,
  MenuRadioItem,
  MenuRadioItem as DropdownMenuRadioItem,
  MenuRadioItemIndicator,
  MenuGroupLabel,
  MenuGroupLabel as DropdownMenuLabel,
  MenuSeparator,
  MenuSeparator as DropdownMenuSeparator,
  MenuShortcut,
  MenuItemDetail,
  MenuShortcut as DropdownMenuShortcut,
  MenuSub,
  MenuSub as DropdownMenuSub,
  MenuSubTrigger,
  MenuSubTrigger as DropdownMenuSubTrigger,
  MenuSubPopup,
  MenuSubPopup as DropdownMenuSubContent,
};
