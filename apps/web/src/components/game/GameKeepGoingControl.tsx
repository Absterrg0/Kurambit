import type { GameKeepGoingMode, ScopedThreadRef } from "@kurambit/contracts";

import {
  MenuGroup,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "../ui/menu";
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

/** Keep going's modes and budget, as the game's top bar menu lists them. */
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
