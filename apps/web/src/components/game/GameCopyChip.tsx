import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@kurambit/contracts";
import { ArrowDownToLineIcon, CopyIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useRef } from "react";

import {
  ComposerControl,
  ComposerControlChevron,
  ComposerControlIcon,
} from "../chat/ComposerControl";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import {
  copyName,
  copySending,
  unresolvedText,
  useCopyActions,
  useCopyPlace,
} from "./useGameCopies";

/**
 * The composer footer's left chip in a chat that works in a copy: "Copy of Build 12", and its
 * menu of the moves between the copy and the game. A chat in the game shows nothing here.
 */
export function GameCopyChip({ threadRef }: { threadRef: ScopedThreadRef | null }) {
  const place = useCopyPlace(threadRef);
  const actions = useCopyActions(threadRef);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sending = useAtomValue(copySending(threadRef));
  if (place === null || threadRef === null) return null;
  const busy = sending !== null || place.state._tag === "checking";
  const working = place.state._tag === "working";
  const blocked = place.noBringIn !== null || unresolvedText(place).length > 0;
  return (
    <Menu>
      <MenuTrigger
        render={
          <ComposerControl
            ref={triggerRef}
            size="xs"
            aria-label={`${copyName(place)}: copy menu`}
            data-game-copy-chip=""
          />
        }
      >
        <ComposerControlIcon size="xs" icon={CopyIcon} />
        <span className="@max-[22rem]/composer-surface:hidden">{copyName(place)}</span>
        <ComposerControlChevron size="xs" />
      </MenuTrigger>
      <MenuPopup
        side="top"
        align="start"
        anchor={() => triggerRef.current?.closest("[data-composer-tray]") ?? null}
        className="min-w-48"
      >
        <MenuItem
          disabled={!actions.canAct || busy || working || blocked}
          onClick={() => void actions.bringIn(threadRef.threadId)}
        >
          <ArrowDownToLineIcon />
          Bring in
        </MenuItem>
        <MenuItem
          disabled={!actions.canAct || busy || working || place.ahead === 0}
          onClick={() => void actions.update(threadRef.threadId)}
        >
          <RefreshCwIcon />
          {place.ahead === 0
            ? "Update"
            : `Update · ${place.ahead} new build${place.ahead === 1 ? "" : "s"}`}
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          variant="destructive"
          disabled={!actions.canAct || busy || working}
          onClick={() => void actions.throwAway(threadRef.threadId, place.builds)}
        >
          <Trash2Icon />
          Throw away…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
