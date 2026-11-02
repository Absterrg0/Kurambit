import { KurambitMark } from "./brand/KurambitBrand";
import { Empty, EmptyDescription, EmptyHeader } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";
import { isElectron } from "../env";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

export function NoActiveThreadState() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          {isElectron ? (
            <span className="text-xs text-muted-foreground/50">No active thread</span>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
                No active thread
              </span>
            </div>
          )}
        </WorkspacePageHeader>

        <Empty className="flex-1">
          <div className="flex w-full max-w-lg flex-col items-center gap-6 px-8 py-12">
            <KurambitMark className="size-20 opacity-80" />
            <EmptyHeader className="max-w-none">
              <h2 className="font-display text-3xl">Pick a thread to continue</h2>
              <EmptyDescription>
                Select an existing thread or create a new one to get started.
              </EmptyDescription>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
