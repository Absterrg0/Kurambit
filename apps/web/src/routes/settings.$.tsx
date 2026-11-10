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
    <SettingsPageContainer>
      <div className="flex flex-col items-start gap-3 py-6">
        <h2 className="text-lg font-medium text-foreground">Page not found</h2>
        <p className="text-sm text-muted-foreground">
          There is no settings page at this address. Pick one from the list, or go back to General.
        </p>
        <Button render={<Link to="/settings/general" replace />}>Back to General</Button>
      </div>
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/$")({ component: SettingsNotFound });
