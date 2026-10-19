import { createFileRoute } from "@tanstack/react-router";

import { GamesHome } from "../components/game/GamesHome";

export const Route = createFileRoute("/_chat/")({
  component: GamesHome,
});
