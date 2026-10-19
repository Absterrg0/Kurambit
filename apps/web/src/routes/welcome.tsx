import { createFileRoute, redirect, useLocation, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import { GamesHome } from "../components/game/GamesHome";
import { WelcomeWizard } from "../components/onboarding/WelcomeWizard";

const decodeEnvironmentId = Schema.decodeOption(EnvironmentId);

export const Route = createFileRoute("/welcome")({
  beforeLoad: ({ context }) => {
    const { authGateState } = context;
    if (authGateState.status !== "authenticated") {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: WelcomeRouteView,
});

function WelcomeRouteView() {
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  const resumeEnvironmentId = hash.startsWith("agents:")
    ? Option.getOrUndefined(decodeEnvironmentId(hash.slice("agents:".length)))
    : undefined;
  // The root shell can remount this pending outlet after the location changes.
  // Never reopen setup while the destination route is still loading.
  const isWelcomeRoute = useLocation({ select: (location) => location.pathname === "/welcome" });
  const [dismissed, setDismissed] = useState(false);
  return (
    <>
      <GamesHome />
      {isWelcomeRoute && !dismissed ? (
        <WelcomeWizard
          resumeEnvironmentId={resumeEnvironmentId}
          onDone={async () => {
            setDismissed(true);
            await navigate({ to: "/", replace: true });
          }}
        />
      ) : null}
    </>
  );
}
