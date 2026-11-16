import { useState, type ReactNode } from "react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChevronDownIcon } from "lucide-react";
import {
  engineDisplayName,
  gameEngineEntry,
  GAME_STYLE_FILE,
  GameStyle,
  type GameThing,
  type GameThingValue,
  type ScopedThreadRef,
} from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import { useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { cn } from "../../lib/utils";
import { gameEnvironment } from "../../state/game";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { Text } from "../ui/text";
import { GameBuildStill, PictureSourceBadge } from "./GameBuildStill";
import { GameCharacterRoutePicker } from "./GameCharacterRoute";
import { GameGeneratedArt } from "./GameGeneratedArt";
import {
  GameGenerationBody,
  GenerationHeading,
  useChoosingCount,
  useGenerationCount,
  useGameGenerations,
  useGenerationActions,
} from "./GameGenerationCard";
import { GameFileActions } from "./GameSavedMedia";
import { buildName } from "./gameBuilds.logic";
import { useStageStill, useThreadStageBridge } from "./gameStageBridge";

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

/** Rows grouped by spacing alone, edge to edge with the section's text: no box around them. */
function Rows({ children }: { children: ReactNode }) {
  return <div className="flex flex-col">{children}</div>;
}

// ─── Scene ────────────────────────────────────────────────────────────────────

const decodeStyle = Schema.decodeUnknownOption(Schema.fromJsonString(GameStyle));

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

/** The Workbench's Art tab, for now (the Art tab's own browser comes next): the game's style, how its characters are made, and the art made for it. */
export function GameLookPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-gutter-both">
      <div className="mx-auto w-full max-w-160 px-4 py-3">
        <LookSection threadRef={threadRef} />
      </div>
    </div>
  );
}

/**
 * A style family's slug as a person would say the look, without the asset
 * pack's vendor: "kenney-lowpoly" reads "Low-poly".
 */
const styleFamilyWords = (family: string) => {
  const words = family
    .toLowerCase()
    .replace(/^(kenney|quaternius|kaykit|polyhaven|synty)[-_ ]?/, "")
    .replace(/low[-_ ]?poly/, "low-poly")
    .replaceAll("_", " ");
  const spaced = words.includes("low-poly") ? words : words.replaceAll("-", " ");
  return spaced.length === 0 ? family : `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
};

/** STYLE.json's family and palette, then the generated art and its picks. */
function LookSection({ threadRef }: { threadRef: ScopedThreadRef }) {
  const root = useIsGameThreadStatus(threadRef).data?.root ?? null;
  const file = useEnvironmentQuery(
    root === null
      ? null
      : projectEnvironment.readFile({
          environmentId: threadRef.environmentId,
          input: { cwd: root, relativePath: GAME_STYLE_FILE },
        }),
  );
  const style = file.data === null ? null : Option.getOrNull(decodeStyle(file.data.contents));
  const swatches = style !== null && Array.isArray(style.palette) ? style.palette : [];
  const [artOpen, setArtOpen] = useState(false);
  const choosing = useChoosingCount(threadRef);
  const generated = useGenerationCount(threadRef);
  // The look shown, not only named: the folder's latest build as its picture.
  const builds = useEnvironmentQuery(
    gameEnvironment.builds({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  ).data;
  const lookBuild = builds?.builds.find((build) => build.id === builds.current) ?? null;
  const buildStill = lookBuild?.still ?? null;
  // A game with no build still has a look: the Stage's last frame of it, once it has shown one.
  const stageStill = useStageStill(scopedThreadKey(threadRef));
  const lookStill = buildStill ?? stageStill;
  const gameName = useIsGameThreadStatus(threadRef).data?.manifest.name ?? "";
  return (
    <Section title="Look">
      {buildStill !== null ? (
        <GameBuildStill
          threadRef={threadRef}
          gameName={gameName}
          build={{ still: buildStill }}
          className="group/sourced aspect-video w-full rounded-lg ring-1 ring-border ring-inset"
        >
          {/* The game has changed since this build: the picture says whose it is, as Now's
              card does, rather than pass for the game as it is now. */}
          {lookBuild !== null && builds?.folderEdited === true ? (
            <PictureSourceBadge>Picture from {buildName(lookBuild)}</PictureSourceBadge>
          ) : null}
        </GameBuildStill>
      ) : stageStill !== null ? (
        <img
          src={stageStill}
          alt=""
          className="aspect-video w-full rounded-lg object-cover ring-1 ring-border ring-inset"
        />
      ) : null}
      {/* The look's colours under its picture, as a strip a person can read at a glance. */}
      {lookStill !== null && swatches.length > 0 ? (
        <div className="flex h-3 overflow-hidden rounded-sm ring-1 ring-border ring-inset">
          {swatches.slice(0, 8).map((hex) => (
            <span key={hex} aria-label={hex} className="flex-1" style={{ background: hex }} />
          ))}
        </div>
      ) : null}
      <Rows>
        <div className="flex min-h-8 items-center gap-2.5 py-1">
          <Text variant="body" tone="default" render={<span className="flex-1" />}>
            Style
          </Text>
          {style === null ? (
            <Text variant="caption" tone="muted">
              Not chosen yet
            </Text>
          ) : (
            <>
              {swatches.length > 0 ? (
                <span className="flex gap-0.5">
                  {swatches.slice(0, 6).map((hex) => (
                    <span
                      key={hex}
                      aria-label={hex}
                      className="size-3.5 rounded-sm ring-1 ring-border ring-inset"
                      style={{ background: hex }}
                    />
                  ))}
                </span>
              ) : null}
              <Text variant="meta" tone="muted" truncate>
                {[
                  style.family === undefined || style.family === null
                    ? null
                    : styleFamilyWords(style.family),
                  style.mode === "pixel" ? "Pixel art" : "Smooth",
                  typeof style.palette === "string" ? style.palette : null,
                ]
                  .filter((part) => part !== null)
                  .join(" · ")}
              </Text>
            </>
          )}
        </div>
        <div className="flex min-h-8 items-center gap-2.5">
          <Text variant="body" tone="default" render={<span className="flex-1" />}>
            Models
          </Text>
          <GameCharacterRoutePicker threadRef={threadRef} />
        </div>
        <button
          type="button"
          aria-expanded={artOpen}
          onClick={() => setArtOpen(!artOpen)}
          className="-mx-2 flex min-h-8 items-center gap-2.5 rounded-md px-2 text-left outline-none hover:surface-selected-soft focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <Text variant="body" tone="default" render={<span className="flex-1" />}>
            Generated art
          </Text>
          {choosing > 0 ? (
            <Text
              variant="caption"
              tone="inherit"
              render={<span className="text-warning-foreground" />}
            >
              {choosing} to pick
            </Text>
          ) : generated === null ? null : (
            // What is inside, like the rows above say theirs: nobody opens it to find it empty.
            <Text variant="meta" tone="muted" numeric>
              {generated === 0 ? "None yet" : generated === 1 ? "1 piece" : `${generated} pieces`}
            </Text>
          )}
          {/* The same trailing ⌄ as Characters' picker: a row that opens more has one mark. */}
          <ChevronDownIcon
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
              artOpen && "rotate-180",
            )}
            aria-hidden="true"
          />
        </button>
      </Rows>
      {style === null ? (
        <Text variant="caption" tone="muted" render={<p />}>
          The agent writes {GAME_STYLE_FILE} when it picks a look.
        </Text>
      ) : null}
      {artOpen ? <GameGeneratedArt threadRef={threadRef} /> : null}
    </Section>
  );
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
      <Section
        title="Look"
        aside={
          <Text variant="caption" tone="muted">
            Generated
          </Text>
        }
      >
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
    <Section
      title="Look"
      aside={
        <Text variant="caption" tone="muted">
          {asset.path.includes("/library/") ? "Library pack" : "Game file"}
        </Text>
      }
    >
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
