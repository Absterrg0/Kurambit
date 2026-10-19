import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { Gamepad2Icon } from "lucide-react";

import { isElectron } from "../../env";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { getLatestThreadForProject } from "../../lib/threadSort";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../../state/entities";
import { sortScopedProjectsForSidebar } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { GameEntry } from "./GameEntry";

const RECENT_LIMIT = 12;

export function GamesHome() {
  const projects = useProjects();
  const threads = useThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const handleNewThread = useNewThreadHandler();
  const navigate = useNavigate();

  const recent = bootstrapped
    ? sortScopedProjectsForSidebar(
        projects.filter((project) => !project.isScratch),
        threads,
        "updated_at",
      ).slice(0, RECENT_LIMIT)
    : [];

  const openGame = (project: (typeof recent)[number]) => {
    const latest = getLatestThreadForProject(threads, project.id, "updated_at");
    if (latest !== null) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: latest.environmentId, threadId: latest.id },
      });
      return;
    }
    void handleNewThread(scopeProjectRef(project.environmentId, project.id));
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        {/* The desktop window only moves where CSS opts in, so keep a titlebar strip. */}
        {isElectron ? <WorkspacePageHeader electron /> : null}
        <Empty size="hero" className="flex-1">
          <div className="w-full max-w-xl px-8 py-12">
            <EmptyHeader className="max-w-none">
              <EmptyTitle>What game should we make?</EmptyTitle>
              <EmptyDescription>
                Describe a game and your agent builds it with Blender and Godot. Play it here, ask
                for changes, and export a build.
              </EmptyDescription>
              <GameEntry />
            </EmptyHeader>
            {recent.length > 0 ? (
              <section className="mt-8 space-y-2 text-left">
                <h2 className="text-sm font-medium text-muted-foreground">Recent games</h2>
                <ul className="space-y-1">
                  {recent.map((project) => (
                    <li key={`${project.environmentId}:${project.id}`}>
                      <Button
                        variant="ghost"
                        className="w-full justify-start"
                        onClick={() => openGame(project)}
                      >
                        <Gamepad2Icon className="size-4" />
                        <span className="truncate">{project.title}</span>
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
