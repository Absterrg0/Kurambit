import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@kurambit/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@kurambit/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BookmarkPlusIcon } from "lucide-react";
import { useState } from "react";

import { gameEnvironment } from "../../state/game";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { exportStageThing, useThreadStageBridge } from "./gameStageBridge";

/**
 * Art's Save to library for a thing the game's code makes, or a part of one: the game writes it
 * as a GLB, and the Library keeps it with its picture and where it came from, so the next game
 * can use it.
 */
export function GameSaveToLibrary({
  threadRef,
  thing,
  name,
  picture,
}: {
  threadRef: ScopedThreadRef;
  /** The thing's id as the game names it ("Island › Cabin"). */
  thing: string;
  name: string;
  picture: string | null;
}) {
  const navigate = useNavigate();
  const canExport = useThreadStageBridge(
    scopedThreadKey(threadRef),
    (state) => state.status === "ready" && state.capabilities.includes("export"),
    false,
  );
  const save = useAtomCommand(gameEnvironment.librarySave, { reportFailure: false });
  const [saving, setSaving] = useState(false);
  if (!canExport) return null;
  const run = async () => {
    setSaving(true);
    const glb = await exportStageThing(thing);
    const result =
      glb === null
        ? null
        : await save({
            environmentId: threadRef.environmentId,
            input: {
              threadId: threadRef.threadId,
              name,
              part: thing,
              glb,
              ...(picture === null ? {} : { png: picture }),
            },
          });
    setSaving(false);
    if (result !== null && result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: result.value.message,
        actionProps: { children: "Open Library", onClick: () => void navigate({ to: "/library" }) },
      });
      return;
    }
    if (result !== null && isAtomCommandInterrupted(result)) return;
    const error = result === null ? null : squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: `Could not save ${name}`,
      description:
        error === null
          ? "The game could not write it. Play it, then try again."
          : error instanceof Error
            ? error.message
            : String(error),
    });
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Save to library"
            disabled={saving}
            onClick={() => void run()}
          />
        }
      >
        <BookmarkPlusIcon aria-hidden="true" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">Save to library</TooltipPopup>
    </Tooltip>
  );
}
