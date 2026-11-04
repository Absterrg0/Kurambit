import type { GameRunProfile } from "@kurambit/contracts";

import { Toggle, ToggleGroup } from "../ui/toggle-group";

export const GAME_RUN_PROFILE_HINT: Record<GameRunProfile, string> = {
  guided:
    "The run asks you in the chat about the look, the prototype and the ladder, and goes on with its own choice if you don't answer.",
  autopilot: "The run decides everything itself.",
};

/** Guided or Autopilot, chosen like a permission mode. */
export function GameRunProfileToggle({
  value,
  onChange,
  disabled,
}: {
  value: GameRunProfile;
  onChange: (profile: GameRunProfile) => void;
  disabled: boolean;
}) {
  return (
    <ToggleGroup
      aria-label="Run profile"
      variant="segmented"
      value={[value]}
      disabled={disabled}
      onValueChange={(next) => {
        const picked = next[0];
        if (picked === "guided" || picked === "autopilot") onChange(picked);
      }}
    >
      <Toggle value="guided">Guided</Toggle>
      <Toggle value="autopilot">Autopilot</Toggle>
    </ToggleGroup>
  );
}
