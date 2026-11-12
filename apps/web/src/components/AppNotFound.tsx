import { Link } from "@tanstack/react-router";

import { Button } from "./ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";

/** An address with no page (a mistyped or old link), inside the pane like any other page. */
export function AppNotFound() {
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh">
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Page not found</EmptyTitle>
          <EmptyDescription>
            This link doesn't point to a page. Go home to pick a game or start a new one.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" render={<Link to="/" replace />}>
            Go home
          </Button>
        </EmptyContent>
      </Empty>
    </SidebarInset>
  );
}
