import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import {
  GAME_CHARACTER_ROUTE_UNAVAILABLE,
  type GameCharacterRoute,
  type ScopedThreadRef,
} from "@kurambit/contracts";
import { Atom } from "effect/reactivity";

import { useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { gameEnvironment } from "../../state/game";
import { useAtomCommand } from "../../state/use-atom-command";
import { MenuCheckboxItem } from "../ui/menu";
import { Text } from "../ui/text";

/** The ways a game's models are made, in the order the person picks from. */
export const CHARACTER_ROUTES: ReadonlyArray<{
  readonly route: GameCharacterRoute;
  readonly label: string;
  readonly description: string;
}> = [
  {
    route: "any",
    label: "Agent's choice",
    description: "The agent picks Blender or code for each model, Blender recommended",
  },
  {
    route: "code",
    label: "Code",
    description: "The agent builds each model in three.js code, in the game itself",
  },
  {
    route: "blender",
    label: "Blender",
    description: "Characters, creatures and the models that matter in Blender",
  },
];

/** Why a route cannot be picked right now, or null when it can. */
export const characterRouteBlocker = (route: GameCharacterRoute): string | null =>
  GAME_CHARACTER_ROUTE_UNAVAILABLE[route] ?? null;

const characterRouteLabel = (route: GameCharacterRoute) =>
  CHARACTER_ROUTES.find((option) => option.route === route)?.label ?? route;

const NO_PERMISSION = Atom.make(false);

/**
 * The game's "Make models with" setting, as every surface reads and sets
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
  const [pending, setPending] = useState<{
    readonly route?: GameCharacterRoute;
    readonly library?: boolean;
  } | null>(null);
  const route = status.data?.characters ?? null;
  const library = status.data?.library ?? null;
  const send = async (next: {
    readonly route?: GameCharacterRoute;
    readonly library?: boolean;
  }) => {
    if (threadRef === null || pending !== null) return;
    setPending(next);
    await set({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, ...next },
    });
    setPending(null);
    status.refresh();
  };
  return {
    /** null until the game's status is read. */
    route,
    library,
    /** The choice on its way to the server, shown as chosen meanwhile. */
    shown: pending?.route ?? route,
    shownLibrary: pending?.library ?? library,
    canSet: permitted && route !== null,
    choose: async (next: GameCharacterRoute) => {
      if (next !== route) await send({ route: next });
    },
    setLibrary: async (next: boolean) => {
      if (next !== library) await send({ library: next });
    },
  };
}

/** The library's own switch: models from the free asset library beside the route's. */
export function LibraryChoice({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (library: boolean) => void;
}) {
  return (
    <MenuCheckboxItem
      variant="switch"
      checked={checked}
      disabled={disabled}
      onCheckedChange={(next) => onChange(next)}
      closeOnClick={false}
    >
      <span className="flex flex-col">
        <Text variant="label">Library models</Text>
        <Text variant="meta" tone="muted">
          Its models, textures and sprites first. Off, a game still takes its clips, sounds and
          fonts
        </Text>
      </span>
    </MenuCheckboxItem>
  );
}

/** How a choice reads in one line: "Code", "Code + library". */
export const modelChoiceLabel = (route: GameCharacterRoute, library: boolean | null) =>
  `${characterRouteLabel(route)}${library === true ? " + library" : ""}`;
