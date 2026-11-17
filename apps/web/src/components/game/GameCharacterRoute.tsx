import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import {
  GAME_CHARACTER_ROUTE_UNAVAILABLE,
  type EnvironmentId,
  type GameCharacterRoute,
  type ScopedThreadRef,
} from "@kurambit/contracts";
import { Atom } from "effect/reactivity";

import { useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { generatedRouteBlocker, generatedRouteNote } from "./gameGeneration.logic";
import { MenuCheckboxItem } from "../ui/menu";
import { Text } from "../ui/text";

/** The ways a game's models are made, in the order the person picks from. */
export const CHARACTER_ROUTES: ReadonlyArray<{
  readonly route: GameCharacterRoute;
  readonly label: string;
  readonly description: string;
}> = [
  {
    route: "code",
    label: "Code",
    description: "The agent builds each model in three.js code, in the game itself",
  },
  {
    route: "blender",
    label: "Blender",
    description: "The agent builds each model in Blender",
  },
  {
    route: "generated",
    label: "Generated",
    description: "Made by an art provider: Codex, or your own keys",
  },
];

/**
 * Why each route cannot be picked right now, or null when it can: the
 * contract's own mark first, then Generated needs a ready art provider (a 3D
 * lane, or Codex for images).
 */
export function useCharacterRouteBlockers(
  environmentId: EnvironmentId | null,
): (route: GameCharacterRoute) => string | null {
  const providers = useEnvironmentQuery(
    environmentId === null ? null : gameEnvironment.artProviders({ environmentId, input: {} }),
  );
  const generated = generatedRouteBlocker(providers.data);
  return (route) =>
    GAME_CHARACTER_ROUTE_UNAVAILABLE[route] ?? (route === "generated" ? generated : null);
}

/** The generated route's caveat for the person picking it, or null; see generatedRouteNote. */
export function useGeneratedRouteNote(environmentId: EnvironmentId | null): string | null {
  const providers = useEnvironmentQuery(
    environmentId === null ? null : gameEnvironment.artProviders({ environmentId, input: {} }),
  );
  return generatedRouteNote(providers.data);
}

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
          Free asset library models first; the route makes what it lacks
        </Text>
      </span>
    </MenuCheckboxItem>
  );
}

/** How a choice reads in one line: "Code", "Code + library". */
export const modelChoiceLabel = (route: GameCharacterRoute, library: boolean | null) =>
  `${characterRouteLabel(route)}${library === true ? " + library" : ""}`;
