import { createFileRoute, notFound, redirect } from "@tanstack/react-router";

import { DesignSystemPage } from "../components/design-system/DesignSystemPage";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";

/** The primitives catalog, in the app shell. Production builds 404. */
export const Route = createFileRoute("/design-system")({
  beforeLoad: ({ context }) => {
    if (!import.meta.env.DEV) throw notFound();
    if (context.authGateState.status !== "authenticated") {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: DesignSystemRoute,
});

function DesignSystemRoute() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Design system breadcrumb">
            <WorkspaceBreadcrumbItem current className="truncate">
              Design system
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <DesignSystemPage />
      </div>
    </SidebarInset>
  );
}
