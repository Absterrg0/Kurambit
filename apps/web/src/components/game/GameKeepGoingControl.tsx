import { FastForwardIcon } from "lucide-react";
import type { GameKeepGoingMode, ScopedThreadRef } from "@kurambit/contracts";

import {
  ComposerControl,
  ComposerControlChevron,
  ComposerControlIcon,
  ComposerControlSeparator,
} from "../chat/ComposerControl";
import { useComposerMenuProps } from "../chat/composerEventScope";
import { useComposerMenuState } from "../chat/useComposerMenuState";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  KEEP_GOING_BUDGETS,
  KEEP_GOING_MODES,
  budgetFromValue,
  budgetValue,
  keepGoingControlView,
} from "./keepGoing.logic";
import { useKeepGoing } from "./useKeepGoing";

const isMode = (value: unknown): value is GameKeepGoingMode =>
  KEEP_GOING_MODES.some((entry) => entry.mode === value);

/**
 * Keep going in the composer's mode position, the way T3's
 * runtime-mode select rises in autonomy: Off, Guided, Autopilot, and a budget.
 * `composer.mode` opens it. It re-renders only when a run push rereads the status.
 */
export function GameKeepGoingControl({
  threadRef,
  size = "sm",
  hidden,
}: {
  threadRef: ScopedThreadRef;
  size?: "sm" | "xs";
  hidden?: boolean;
}) {
  const keepGoing = useKeepGoing(threadRef);
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(hidden);
  const view = keepGoingControlView({
    status: keepGoing.status,
    error: keepGoing.error,
    threadId: threadRef.threadId,
    canOperate: keepGoing.canOperate,
    sending: keepGoing.sending,
    chosenBudget: keepGoing.chosenBudget,
  });
  const trigger = (
    <>
      <ComposerControlIcon icon={FastForwardIcon} size={size} />
      <span data-composer-control-label>{view.label}</span>
      <ComposerControlChevron size={size} />
    </>
  );
  if (view.disabled !== null)
    return (
      <>
        <ComposerControlSeparator size={size} />
        <Tooltip>
          {/* A disabled button takes no hover: the reason sits on its wrapper. */}
          <TooltipTrigger render={<span className="inline-flex" />}>
            <ComposerControl size={size} disabled aria-label="Keep going">
              {trigger}
            </ComposerControl>
          </TooltipTrigger>
          <TooltipPopup side="top">{view.disabled}</TooltipPopup>
        </Tooltip>
      </>
    );
  return (
    <>
      <ComposerControlSeparator size={size} />
      <Menu open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <ComposerControl
                    size={size}
                    className="shrink-0 whitespace-nowrap"
                    aria-label="Keep going"
                    aria-pressed={view.pressed}
                    data-composer-shortcut="composer.mode"
                  />
                }
              />
            }
          >
            {trigger}
          </TooltipTrigger>
          <TooltipPopup side="top">{view.tooltip}</TooltipPopup>
        </Tooltip>
        <MenuPopup align="start" {...composerFloatingLayerProps}>
          <GameKeepGoingMenuContent threadRef={threadRef} />
        </MenuPopup>
      </Menu>
    </>
  );
}

/**
 * The control's two radio groups, also shown in the composer's overflow menu
 * when the mode block does not fit.
 */
export function GameKeepGoingMenuContent({ threadRef }: { threadRef: ScopedThreadRef }) {
  const keepGoing = useKeepGoing(threadRef);
  const view = keepGoingControlView({
    status: keepGoing.status,
    error: keepGoing.error,
    threadId: threadRef.threadId,
    canOperate: keepGoing.canOperate,
    sending: keepGoing.sending,
    chosenBudget: keepGoing.chosenBudget,
  });
  return (
    <>
      <MenuGroup>
        <MenuGroupLabel>Keep going</MenuGroupLabel>
        <MenuRadioGroup
          value={view.value}
          onValueChange={(value) => {
            if (isMode(value)) void keepGoing.choose(value);
          }}
        >
          {KEEP_GOING_MODES.map((option) => (
            <MenuRadioItem
              key={option.mode}
              value={option.mode}
              disabled={
                view.disabled !== null || (option.mode !== "off" && view.modesDisabled !== null)
              }
              className="min-w-64"
            >
              <span className="grid min-w-0 gap-0.5">
                <span className="font-medium">{option.label}</span>
                <span className="text-muted-foreground text-xs leading-4">
                  {option.mode !== "off" && view.modesDisabled !== null
                    ? view.modesDisabled
                    : option.description}
                </span>
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuGroup>
      <MenuSeparator />
      <MenuGroup>
        <MenuGroupLabel>{view.budgetLabel}</MenuGroupLabel>
        <MenuRadioGroup
          value={budgetValue(view.budget)}
          onValueChange={(value) => {
            if (typeof value === "string") keepGoing.setBudget(budgetFromValue(value));
          }}
        >
          {KEEP_GOING_BUDGETS.map((option) => (
            <MenuRadioItem
              key={budgetValue(option.minutes)}
              value={budgetValue(option.minutes)}
              disabled={view.disabled !== null || view.budgetDisabled}
            >
              {option.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuGroup>
    </>
  );
}
