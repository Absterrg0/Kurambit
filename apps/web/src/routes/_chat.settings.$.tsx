import { Link, createFileRoute } from "@tanstack/react-router";

import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";

/**
 * A settings address with no page (a mistyped or old link). Without it the
 * two segments of `/settings/git` match a thread's `/$environmentId/$threadId`
 * and the pane stays blank.
 */
function SettingsNotFound() {
  return (
    <SettingsPageContainer
      title="Page not found"
      description="There is no settings page at this address. Pick one from the list, or go back to General."
    >
      <div className="px-3 sm:px-4">
        <Button render={<Link to="/settings/general" replace />}>Back to General</Button>
      </div>
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/_chat/settings/$")({ component: SettingsNotFound });
