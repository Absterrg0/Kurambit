import { createFileRoute, redirect } from "@tanstack/react-router";

// The local server is one row in General's About now; old links and the
// desktop's settings deep link still land on it.
export const Route = createFileRoute("/_chat/settings/connections")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/general", hash: "connections-environment", replace: true });
  },
});
