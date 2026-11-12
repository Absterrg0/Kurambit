import { createFileRoute } from "@tanstack/react-router";

import { GameToolsSettingsPanel } from "../components/settings/GameToolsSettings";

export const Route = createFileRoute("/_chat/settings/game-tools")({
  component: GameToolsSettingsPanel,
});
