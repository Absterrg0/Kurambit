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
import { ChevronDownIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Text } from "../ui/text";

/** The ways a game's characters are made, in the order the person picks from. */
export const CHARACTER_ROUTES: ReadonlyArray<{
  readonly route: GameCharacterRoute;
  readonly label: string;
  readonly description: string;
}> = [
  {
    route: "library",
    label: "Library",
    description: "Characters from the asset library's packs",
  },
  {
    route: "blender",
    label: "Blender",
    description: "The agent builds each character in Blender",
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
    canSet: permitted && route !== null,
    choose,
  };
}

/** The three choices as menu radio items, with the generated route's note. */
function CharacterRouteChoices({ threadRef }: { threadRef: ScopedThreadRef }) {
  const { shown, choose } = useCharacterRoute(threadRef);
  const blocker = useCharacterRouteBlockers(threadRef.environmentId);
  const generatedNote = useGeneratedRouteNote(threadRef.environmentId);
  return (
    <>
      <MenuRadioGroup
        value={shown}
        onValueChange={(value: GameCharacterRoute) => void choose(value)}
      >
        {CHARACTER_ROUTES.map((option) => {
          const blocked = blocker(option.route);
          return (
            <MenuRadioItem
              key={option.route}
              value={option.route}
              // The current route stays checkable even when its providers went away.
              disabled={blocked !== null && shown !== option.route}
            >
              <span className="flex flex-col">
                <Text variant="label">{option.label}</Text>
                <Text variant="meta" tone="muted">
                  {blocked ?? option.description}
                </Text>
              </span>
            </MenuRadioItem>
          );
        })}
      </MenuRadioGroup>
      {shown === "generated" && generatedNote !== null ? (
        <Text variant="meta" tone="muted" render={<p className="max-w-64 px-2 py-1.5" />}>
          {generatedNote}
        </Text>
      ) : null}
    </>
  );
}

/** The game's "Make characters with…" submenu, for menus that hold it. */
export function GameCharacterRouteMenu({ threadRef }: { threadRef: ScopedThreadRef }) {
  const { canSet } = useCharacterRoute(threadRef);
  return (
    <MenuSub>
      <MenuSubTrigger disabled={!canSet}>Make characters with…</MenuSubTrigger>
      <MenuSubPopup className="w-72">
        <CharacterRouteChoices threadRef={threadRef} />
      </MenuSubPopup>
    </MenuSub>
  );
}

/** The Scene tab's Characters row: the current route, and a menu to change it. */
export function GameCharacterRoutePicker({ threadRef }: { threadRef: ScopedThreadRef }) {
  const { shown, canSet } = useCharacterRoute(threadRef);
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button size="xs" variant="ghost" disabled={!canSet} aria-label="Make characters with" />
        }
      >
        {shown === null ? "…" : characterRouteLabel(shown)}
        <ChevronDownIcon aria-hidden="true" />
      </MenuTrigger>
      <MenuPopup align="end" className="w-72">
        <MenuGroup>
          <MenuGroupLabel>Make characters with</MenuGroupLabel>
          <CharacterRouteChoices threadRef={threadRef} />
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
