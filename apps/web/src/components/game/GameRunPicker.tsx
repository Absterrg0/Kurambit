import type { ScopedThreadRef } from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import { ArrowRightIcon, FastForwardIcon } from "lucide-react";
import { useRef } from "react";

import { openGameTool } from "../../gameArrivalStore";
import { useGameWorkspaceStore } from "../../gameWorkspaceStore";
import {
  ComposerControl,
  ComposerControlChevron,
  ComposerControlIcon,
} from "../chat/ComposerControl";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { ArrivalDot } from "./ArrivalDot";
import {
  KEEP_GOING_BUDGETS,
  budgetFromValue,
  budgetValue,
  keepGoingControlView,
  runPick,
} from "./keepGoing.logic";
import { useGameArrivals } from "./useGameArrivals";
import { useKeepGoing } from "./useKeepGoing";

/** A choice's row: its name, and the check on the chosen one (its fill alone matches hover). */
function Choice({ children }: { children: string }) {
  return (
    <span className="flex w-full min-w-0 items-center gap-2">
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <MenuRadioItemIndicator />
    </span>
  );
}

/**
 * What a game chat's Send does: one turn, or Keep going, whose own steps follow and whose
 * direction the message is. Its label is the choice; while keep going is on in the chat it reads
 * Keep going unless the person picked Once. The budget is in the same menu from its first open.
 * Until Keep going arrives (a build that starts, with a `Next:` line), Send sends once and there
 * is nothing to pick: the picker is absent.
 */
export function GameRunPicker({
  threadRef,
  disabled,
}: {
  /** Null on a chat not started yet: it sends once. */
  threadRef: ScopedThreadRef | null;
  disabled: boolean;
}) {
  const threadKey = threadRef === null ? null : scopedThreadKey(threadRef);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const picked = useGameWorkspaceStore((state) =>
    threadKey === null ? undefined : state.keepGoingPick[threadKey],
  );
  const pickRun = useGameWorkspaceStore((state) => state.pickRun);
  const keepGoing = useKeepGoing(threadRef);
  const view = keepGoingControlView({
    status: keepGoing.status,
    error: keepGoing.error,
    threadId: threadRef?.threadId ?? "",
    canOperate: keepGoing.canOperate,
    sending: keepGoing.sending,
    chosenBudget: keepGoing.chosenBudget,
  });
  const pick = runPick(picked, keepGoing.status, threadRef?.threadId ?? "");
  const arrivals = useGameArrivals(threadRef);
  const keepGoingShown = arrivals.keepGoing.shown || pick === "keep-going";
  if (!keepGoingShown) return null;
  const keepGoingBlocked = view.pressed ? null : (view.modesDisabled ?? view.disabled);
  const label = pick === "keep-going" ? "Keep going" : "Once";
  return (
    <Menu
      onOpenChange={(open) => {
        if (!open) return;
        openGameTool("keep-going");
      }}
    >
      <MenuTrigger
        render={
          <ComposerControl
            ref={triggerRef}
            size="xs"
            disabled={disabled}
            aria-label={`Send: ${label}`}
            data-game-run-picker=""
          />
        }
      >
        <ComposerControlIcon
          size="xs"
          icon={pick === "keep-going" ? FastForwardIcon : ArrowRightIcon}
        />
        {/* The narrowest composer keeps the icon; the name is the trigger's label. */}
        <span className="@max-[22rem]/composer-surface:hidden">{label}</span>
        <ComposerControlChevron size="xs" />
        <ArrivalDot on={arrivals.keepGoing.dot} />
      </MenuTrigger>
      {/* Over the whole composer, not over the text row it sits under. */}
      <MenuPopup
        side="top"
        align="start"
        anchor={() => triggerRef.current?.closest("[data-composer-tray]") ?? null}
        className="min-w-48"
      >
        <MenuRadioGroup
          value={pick}
          onValueChange={(value) => {
            if (threadKey !== null && (value === "once" || value === "keep-going"))
              pickRun(threadKey, value);
          }}
        >
          <MenuRadioItem value="once">
            <Choice>Once</Choice>
          </MenuRadioItem>
          {keepGoingShown ? (
            <MenuRadioItem
              value="keep-going"
              disabled={threadKey === null || keepGoingBlocked !== null}
              {...(keepGoingBlocked === null ? {} : { title: keepGoingBlocked })}
            >
              <Choice>Keep going</Choice>
            </MenuRadioItem>
          ) : null}
        </MenuRadioGroup>
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
                disabled={threadKey === null || view.budgetDisabled}
              >
                <Choice>{option.label}</Choice>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
