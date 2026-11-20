import type { GameRunProfile, ScopedThreadRef } from "@kurambit/contracts";
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
} from "./keepGoing.logic";
import { useGameArrivals } from "./useGameArrivals";
import { useKeepGoing } from "./useKeepGoing";

const PROFILES: ReadonlyArray<{ readonly profile: GameRunProfile; readonly label: string }> = [
  { profile: "guided", label: "Guided" },
  { profile: "autopilot", label: "Autopilot" },
];
const isProfile = (value: unknown): value is GameRunProfile =>
  PROFILES.some((entry) => entry.profile === value);

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
 * direction the message is. Its label is the choice. Until Keep going arrives (a build that
 * starts, with a `Next:` line), Send sends once and there is nothing to pick: the picker is absent.
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
  const keepGoingProfile = useGameWorkspaceStore((state) =>
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
  const pick = keepGoingProfile !== undefined ? "keep-going" : "once";
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
            if (threadKey === null) return;
            if (value === "once") pickRun(threadKey, { kind: "once" });
            else if (value === "keep-going")
              pickRun(threadKey, {
                kind: "keep-going",
                profile: view.pressed && isProfile(view.value) ? view.value : "guided",
              });
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
        {pick === "keep-going" && threadKey !== null ? (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>Keep going</MenuGroupLabel>
              <MenuRadioGroup
                value={keepGoingProfile}
                onValueChange={(value) => {
                  if (!isProfile(value)) return;
                  pickRun(threadKey, { kind: "keep-going", profile: value });
                  // Live here, the run switches now; otherwise Send starts it in this mode.
                  if (view.pressed) void keepGoing.choose(value);
                }}
              >
                {PROFILES.map((entry) => (
                  <MenuRadioItem key={entry.profile} value={entry.profile}>
                    <Choice>{entry.label}</Choice>
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
                    disabled={view.budgetDisabled}
                  >
                    <Choice>{option.label}</Choice>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
