import { scopeProjectRef } from "@kurambit/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@kurambit/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@kurambit/contracts";
import { useState } from "react";
import { create } from "zustand";

import { useProject } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { useGameLibraryRefresh } from "./useGameLibrary";

/**
 * A game's name is its project's title. game.json keeps the name the game was
 * created with, so renaming never touches the game's files or its next build.
 */
export function useGameName(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
  fallback: string,
): string {
  const project = useProject(projectId === null ? null : scopeProjectRef(environmentId, projectId));
  return project?.title ?? fallback;
}

/** Which game is being renamed in place, so a menu can start it in the row that shows it. */
export const useGameRenameStore = create<{
  renaming: string | null;
  start: (projectId: ProjectId) => void;
  stop: () => void;
}>((set) => ({
  renaming: null,
  start: (renaming) => set({ renaming }),
  stop: () => set({ renaming: null }),
}));

export function useRenameGame(environmentId: EnvironmentId) {
  const update = useOrchestrationCommand(projectEnvironment.update, { reportFailure: false });
  const refreshLibrary = useGameLibraryRefresh(environmentId);
  return async (projectId: ProjectId, title: string) => {
    const result = await update({ environmentId, input: { projectId, title } });
    if (result._tag === "Success") {
      refreshLibrary();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Could not rename the game",
      description: error instanceof Error ? error.message : String(error),
    });
  };
}

/** The name as an input: Enter or leaving it keeps the new name, Escape keeps the old one. */
export function GameNameInput(props: {
  name: string;
  onRename: (name: string) => void;
  onDone: () => void;
  className?: string;
}) {
  const [value, setValue] = useState(props.name);
  const [settled, setSettled] = useState(false);
  const finish = (keep: boolean) => {
    if (settled) return;
    setSettled(true);
    const next = value.trim();
    if (keep && next.length > 0 && next !== props.name) props.onRename(next);
    props.onDone();
  };
  return (
    <Input
      aria-label="Game name"
      value={value}
      maxLength={100}
      size="sm"
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") finish(true);
        if (event.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
      className={props.className}
    />
  );
}
