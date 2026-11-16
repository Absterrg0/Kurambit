import type { ReactNode } from "react";
import {
  engineDisplayName,
  gameEngineEntry,
  type GameThing,
  type GameThingValue,
  type ScopedThreadRef,
} from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import { useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { Button } from "../ui/button";
import { Text } from "../ui/text";
import {
  GameGenerationBody,
  GenerationHeading,
  useGameGenerations,
  useGenerationActions,
} from "./GameGenerationCard";
import { GameFileActions } from "./GameSavedMedia";
import { useThreadStageBridge } from "./gameStageBridge";

/** A titled group. The heading reads above its rows; a count after it stays quieter. */
function Section({
  title,
  detail,
  aside,
  children,
}: {
  title: string;
  /** The summary line: words, or a placeholder holding its line while they are read. */
  detail?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <div className="flex min-h-6 items-center gap-2">
          <Text variant="label" tone="strong" render={<h3 />}>
            {title}
          </Text>
          {aside === undefined ? null : <span className="ml-auto flex items-center">{aside}</span>}
        </div>
        {/* The summary has its own line and wraps: no count is ever cut off. */}
        {detail === undefined || detail === null || detail === "" ? null : typeof detail ===
          "string" ? (
          <Text variant="meta" tone="muted" numeric render={<p />}>
            {detail}
          </Text>
        ) : (
          detail
        )}
      </div>
      {children}
    </section>
  );
}

// ─── Scene ────────────────────────────────────────────────────────────────────

/**
 * Why there is nothing to select, said as what is true now: this engine or this game's shell
 * cannot point at things, the game is not on the Stage, or it has not answered yet. Null when
 * selecting works, and the list itself says whether it is empty.
 */
export function useSelectNotice(
  threadRef: ScopedThreadRef,
): { readonly title: string; readonly body: string } | null {
  const engine = useIsGameThreadStatus(threadRef).data?.manifest.engine.name ?? null;
  const status = useThreadStageBridge(scopedThreadKey(threadRef), (state) => state.status, null);
  if (engine !== null && gameEngineEntry(engine)?.stageBridge !== true)
    return {
      title: "Not in this engine yet",
      body: `Pointing at things in the running game is not in ${engineDisplayName(engine)} yet.`,
    };
  if (status === "none")
    return {
      title: "This game's shell is older",
      body: "Pointing at things needs the newer game shell, which games made from now on have. Freeze still pauses this one.",
    };
  if (status === null)
    return {
      title: "Play the game to tune it",
      body: "Its speeds, jump height, timers and counts show here while it runs on the Stage, to change as you play.",
    };
  if (status === "waiting")
    return {
      title: "Waiting for the game",
      body: "The game is starting. Its named things show here once it answers.",
    };
  return null;
}

/** Its model or sprite and where it comes from: a generation's own card, or the file. */
export function ThingLook({ threadRef, thing }: { threadRef: ScopedThreadRef; thing: GameThing }) {
  const root = useIsGameThreadStatus(threadRef).data?.root ?? null;
  const generations = useGameGenerations(threadRef).data;
  const actions = useGenerationActions(threadRef);
  const asset = thing.asset;
  // Drawn by the game's code: there is no file or generation to show.
  if (asset === undefined) return null;
  const generation =
    generations?.generations.find(
      (entry) =>
        entry.files.includes(asset.path) ||
        (asset.sidecar !== undefined && entry.files.includes(asset.sidecar)),
    ) ?? null;
  if (generation !== null)
    return (
      <Section title="Look" aside={<OpenInArt path={asset.path} />}>
        <GenerationHeading generation={generation} />
        <GameGenerationBody
          threadRef={threadRef}
          root={root}
          generation={generation}
          actions={actions}
        />
      </Section>
    );
  return (
    <Section title="Look" aside={<OpenInArt path={asset.path} />}>
      <Text variant="caption" tone="muted" mono render={<code className="break-all" />}>
        {asset.path}
      </Text>
      {root === null ? null : (
        <div className="-ms-2 flex flex-wrap items-center gap-1">
          <GameFileActions
            threadRef={threadRef}
            path={`${root}/${asset.path}`}
            relativePath={asset.path}
          />
        </div>
      )}
    </Section>
  );
}

/** The thing's file in the Workbench's Art: its viewer, where it came from, and its tint and scale. */
function OpenInArt({ path }: { path: string }) {
  return (
    <Button
      size="xs"
      variant="ghost"
      onClick={() => useGameWorkspaceStore.getState().openArtAsset(path)}
    >
      Open in Art
    </Button>
  );
}

/** Short words a player writes in capitals: "maxHp" reads "Max HP". */
const VALUE_ACRONYMS: ReadonlySet<string> = new Set([
  "hp",
  "xp",
  "mp",
  "ap",
  "fov",
  "ai",
  "ui",
  "hud",
  "fps",
  "npc",
  "dps",
]);

/** A value's name as a person reads it: the game's label, else its key in words ("dashCooldown" → "Dash cooldown"). */
export const valueLabel = (value: GameThingValue) => {
  if (value.label !== undefined) return value.label;
  const words = value.key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .map((word) => (VALUE_ACRONYMS.has(word) ? word.toUpperCase() : word))
    .join(" ");
  return words.length === 0 ? value.key : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};
