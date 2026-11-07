import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import type { GameCharacterRoute, ScopedThreadRef } from "@kurambit/contracts";
import { Atom } from "effect/reactivity";

import { useGameStageAccess } from "../../hooks/useGameStageAccess";
import { useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { gameEnvironment } from "../../state/game";
import { useAtomCommand } from "../../state/use-atom-command";
import { MenuRadioGroup, MenuRadioItem, MenuSub, MenuSubPopup, MenuSubTrigger } from "../ui/menu";

/** The ways a game's characters are made, in the order the person picks from. */
export const CHARACTER_ROUTES: ReadonlyArray<{
  readonly route: GameCharacterRoute;
  readonly label: string;
  readonly description: string;
  /** Why it cannot be picked yet; null when it can. */
  readonly unavailable: string | null;
}> = [
  {
    route: "library",
    label: "Library",
    description: "Characters from the asset library's packs",
    unavailable: null,
  },
  {
    route: "blender",
    label: "Blender",
    description: "The agent builds each character in Blender",
    unavailable: null,
  },
  {
    route: "tripo",
    label: "Tripo",
    description: "Generated with your Tripo key",
    unavailable: "Not available yet",
  },
];

export const characterRouteLabel = (route: GameCharacterRoute) =>
  CHARACTER_ROUTES.find((option) => option.route === route)?.label ?? route;

const NO_PERMISSION = Atom.make(false);

/**
 * The game's "Make characters with" setting, as every surface reads and sets
 * it: the server holds it in game.json, and only the person changes it.
 */
export function useCharacterRoute(threadRef: ScopedThreadRef | null) {
  const status = useIsGameThreadStatus(threadRef);
  const set = useAtomCommand(gameEnvironment.setCharacterRoute);
  const permitted = useAtomValue(
    threadRef === null
      ? NO_PERMISSION
      : gameEnvironment.setCharacterRoute.permissionAtom(threadRef.environmentId),
  );
  // A run's role thread never writes beside the run.
  const access = useGameStageAccess(threadRef);
  const [pending, setPending] = useState<GameCharacterRoute | null>(null);
  const route = status.data?.characters ?? null;
  const choose = async (next: GameCharacterRoute) => {
    if (threadRef === null || pending !== null || next === route) return;
    setPending(next);
    await set({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, route: next },
    });
    setPending(null);
    status.refresh();
  };
  return {
    /** null until the game's status is read. */
    route,
    /** The choice on its way to the server, shown as chosen meanwhile. */
    shown: pending ?? route,
    canSet: permitted && access === "writer" && route !== null,
    choose,
  };
}

/** The game's More menu entry: "Make characters with…" and its three choices. */
export function GameCharacterRouteMenu({ threadRef }: { threadRef: ScopedThreadRef }) {
  const { shown, canSet, choose } = useCharacterRoute(threadRef);
  return (
    <MenuSub>
      <MenuSubTrigger disabled={!canSet}>Make characters with…</MenuSubTrigger>
      <MenuSubPopup>
        <MenuRadioGroup
          value={shown}
          onValueChange={(value: GameCharacterRoute) => void choose(value)}
        >
          {CHARACTER_ROUTES.map((option) => (
            <MenuRadioItem
              key={option.route}
              value={option.route}
              disabled={option.unavailable !== null}
            >
              {option.unavailable === null
                ? option.label
                : `${option.label} · ${option.unavailable.toLowerCase()}`}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuSubPopup>
    </MenuSub>
  );
}
