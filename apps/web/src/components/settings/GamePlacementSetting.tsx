import { type GamePlacement, useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const PLACEMENT_LABELS: Record<GamePlacement, string> = {
  above: "Above the chat",
  right: "Beside the chat",
};

/** Where a game's Stage sits on its screen; the game's menu changes the same choice. */
export function GamePlacementSetting() {
  const placement = useGameWorkspaceStore((state) => state.gamePlacement);
  const setPlacement = useGameWorkspaceStore((state) => state.setGamePlacement);
  return (
    <SettingsRow
      {...searchableSetting("game-placement")}
      description="On top of the chat, or in its own column beside it. A narrow window always stacks them."
      control={
        <Select
          value={placement}
          onValueChange={(value) => {
            if (value === "above" || value === "right") setPlacement(value);
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Where the game plays">
            <SelectValue>{PLACEMENT_LABELS[placement]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem hideIndicator value="above">
              {PLACEMENT_LABELS.above}
            </SelectItem>
            <SelectItem hideIndicator value="right">
              {PLACEMENT_LABELS.right}
            </SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );
}
