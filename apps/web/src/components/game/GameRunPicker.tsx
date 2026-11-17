import type { GameRunProfile, ScopedThreadRef } from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import { ArrowRightIcon, FastForwardIcon, SplitIcon } from "lucide-react";

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
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import {
  KEEP_GOING_BUDGETS,
  budgetFromValue,
  budgetValue,
  keepGoingControlView,
} from "./keepGoing.logic";
import { useKeepGoing } from "./useKeepGoing";

const WAYS = [2, 3, 4] as const;
const PROFILES: ReadonlyArray<{ readonly profile: GameRunProfile; readonly label: string }> = [
  { profile: "guided", label: "Guided" },
  { profile: "autopilot", label: "Autopilot" },
];
const isProfile = (value: unknown): value is GameRunProfile =>
  PROFILES.some((entry) => entry.profile === value);

/**
 * What a game chat's Send does: one turn, the same message tried several ways at once, or Keep
 * going, whose own steps follow and whose direction the message is. Its label is the choice.
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
  const ways = useGameWorkspaceStore((state) =>
    threadKey === null ? undefined : state.tryWays[threadKey],
  );
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
  const pick = keepGoingProfile !== undefined ? "keep-going" : ways !== undefined ? "ways" : "once";
  const keepGoingBlocked = view.pressed ? null : (view.modesDisabled ?? view.disabled);
  const label =
    pick === "keep-going" ? "Keep going" : pick === "ways" ? `Try ${ways} ways` : "Once";
  return (
    <Menu>
      <MenuTrigger
        render={
          <ComposerControl
            className="text-foreground"
            disabled={disabled}
            aria-label={`Send: ${label}`}
            data-game-run-picker=""
          />
        }
      >
        <ComposerControlIcon
          icon={
            pick === "keep-going" ? FastForwardIcon : pick === "ways" ? SplitIcon : ArrowRightIcon
          }
        />
        {/* The narrowest composer keeps the icon; the name is the trigger's label. */}
        <span className="@max-[22rem]/composer-surface:hidden">{label}</span>
        <ComposerControlChevron />
      </MenuTrigger>
      <MenuPopup side="top" align="start" className="min-w-48">
        <MenuRadioGroup
          value={pick}
          onValueChange={(value) => {
            if (threadKey === null) return;
            if (value === "once") pickRun(threadKey, { kind: "once" });
            else if (value === "ways") pickRun(threadKey, { kind: "ways", ways: ways ?? 3 });
            else if (value === "keep-going")
              pickRun(threadKey, {
                kind: "keep-going",
                profile: view.pressed && isProfile(view.value) ? view.value : "guided",
              });
          }}
        >
          <MenuRadioItem value="once">Once</MenuRadioItem>
          <MenuRadioItem value="ways" disabled={threadKey === null}>
            {`Try ${ways ?? 3} ways`}
          </MenuRadioItem>
          <MenuRadioItem
            value="keep-going"
            disabled={threadKey === null || keepGoingBlocked !== null}
            {...(keepGoingBlocked === null ? {} : { title: keepGoingBlocked })}
          >
            Keep going
          </MenuRadioItem>
        </MenuRadioGroup>
        {pick === "ways" && threadKey !== null ? (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>Ways</MenuGroupLabel>
              <MenuRadioGroup
                value={String(ways)}
                onValueChange={(value) => pickRun(threadKey, { kind: "ways", ways: Number(value) })}
              >
                {WAYS.map((each) => (
                  <MenuRadioItem key={each} value={String(each)}>
                    {each}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </>
        ) : null}
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
                    {entry.label}
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
                    {option.label}
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
