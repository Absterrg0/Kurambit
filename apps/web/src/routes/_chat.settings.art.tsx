import { createFileRoute } from "@tanstack/react-router";

import { GameArtSettingsPanel } from "../components/settings/GameArtSettings";

export const Route = createFileRoute("/_chat/settings/art")({
  component: GameArtSettingsPanel,
});
