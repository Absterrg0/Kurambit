import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  GAME_STYLE_FILE,
  GameStyle,
  manifestRuntime,
  type GameArtAsset,
  type GameAssetUse,
  type GameThing,
  type GameThingFacts,
  type GameThingValue,
  type ScopedThreadRef,
} from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import {
  ChevronLeftIcon,
  CrosshairIcon,
  ImageIcon,
  MessageSquarePlusIcon,
  PauseIcon,
  PlayIcon,
  ShapesIcon,
  SlidersHorizontalIcon,
} from "lucide-react";

import { useAssetUrlState } from "../../assets/assetUrls";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { cn } from "../../lib/utils";
import { gameEnvironment } from "../../state/game";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Text } from "../ui/text";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  ArtThumbnailPainter,
  AudioViewer,
  FONT_SAMPLE,
  FontViewer,
  ModelViewer,
  TextureViewer,
  useFontFamily,
  useSoundPeaks,
  type ModelViewerHandle,
  type ViewerModelInfo,
} from "./GameArtViewers";
import { useGameGenerations } from "./GameGenerationCard";
import { GameKeyArt } from "./GameKeyArt";
import { GameThingPicture, useStageBuild, useThingFacts } from "./GameThingPicture";
import { GameTuneField } from "./GameTuneField";
import { KIND_WORDS, useTuneSaver } from "./GameTune";
import { Workbench } from "./GameWorkbenchParts";
import {
  artSections,
  bytesWords,
  clipTime,
  CODE_MODEL_PREFIX,
  codeModels,
  countWords,
  entryKey,
  fileName,
  inPlayWords,
  isUnused,
  ROUTE_WORDS,
  thingOfAsset,
  type ArtFilter,
  type GameArtCodeModel,
  type GameArtEntry,
} from "./gameArt.logic";
import { refOf } from "./gameBuildRef";
import { attachAssetToComposer } from "./gameComposerContext";
import { showWorkbench } from "./gameWorkbenchPanel";
import {
  hoverStageThing,
  pointAtStageThing,
  portraitStageThing,
  selectStageThing,
  tuneStageValue,
  useThreadStageBridge,
} from "./gameStageBridge";

const NO_THINGS: ReadonlyArray<GameThing> = [];
const NO_ASSETS: ReadonlyArray<GameArtAsset> = [];

/** The runtime's model viewer page on the game's own server; null when the game has none. */
function useViewerUrl(threadRef: ScopedThreadRef): string | null {
  const status = useIsGameThreadStatus(threadRef).data;
  if (status === undefined || status === null) return null;
  const major = manifestRuntime(status.manifest);
  if (status.previewUrl === null || major === null || status.manifest.engine.name !== "three")
    return null;
  return new URL(`_kurambit/runtime/three/${major}/shell/viewer.html`, status.previewUrl).href;
}

/** What the build on the Stage's plays loaded and played; null before they measured it. */
function useAssetUse(threadRef: ScopedThreadRef): GameAssetUse | null {
  const builds = useEnvironmentQuery(
    gameEnvironment.builds({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  ).data;
  const current = builds?.builds.find((build) => build.id === builds.current) ?? null;
  const facts = useEnvironmentQuery(
    current === null || !current.available
      ? null
      : gameEnvironment.buildFacts({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, build: refOf(current) },
        }),
  ).data;
  return facts?.use.status === "measured" ? facts.use.value : null;
}

/**
 * The Workbench's Art, an asset browser: search and a filter over the game's models (its code's
 * and its files), textures, sounds and fonts. Models and textures are a grid of pictures, sounds
 * a list with their waveforms, fonts a line set in each. Opening one shows it in a viewer of its
 * kind with its facts and the changes it really has.
 */
export function GameArtPanel({
  threadRef,
  onAsk,
}: {
  threadRef: ScopedThreadRef;
  onAsk: (text: string) => void;
}) {
  const threadKey = scopedThreadKey(threadRef);
  const status = useIsGameThreadStatus(threadRef).data ?? null;
  const read = useEnvironmentQuery(
    gameEnvironment.artAssets({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const assets = read.data?.assets ?? NO_ASSETS;
  const things = useThreadStageBridge(threadKey, (state) => state.things, NO_THINGS);
  const code = codeModels(things);
  const use = useAssetUse(threadRef);
  const viewerUrl = useViewerUrl(threadRef);
  const build = useStageBuild(threadRef);
  const selected = useGameWorkspaceStore((state) => state.artAsset);
  const setSelected = useGameWorkspaceStore((state) => state.setArtAsset);
  // Thumbnails drawn this session, by content, shown before the list reads them back.
  const [drawn, setDrawn] = useState<ReadonlyMap<string, string | null>>(new Map());
  const keepThumbnail = useAtomCommand(gameEnvironment.artThumbnail, { reportFailure: false });
  const entry: GameArtEntry | null =
    selected === null
      ? null
      : selected.startsWith(CODE_MODEL_PREFIX)
        ? (code.find((model) => `${CODE_MODEL_PREFIX}${model.id}` === selected) ?? null)
        : (() => {
            const asset = assets.find((each) => each.path === selected);
            return asset === undefined ? null : { kind: "file" as const, asset };
          })();
  const root = status?.root ?? null;
  const wanted = assets.filter(
    (asset) => asset.kind === "model" && asset.thumbnail === undefined && !drawn.has(asset.sha256),
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {entry === null || root === null ? (
        <ArtList
          threadRef={threadRef}
          root={root}
          build={build}
          assets={assets}
          code={code}
          use={use}
          drawn={drawn}
          loading={read.data === null || read.data === undefined}
          more={read.data?.more ?? 0}
          onOpen={(next) => setSelected(entryKey(next))}
        />
      ) : (
        <ArtDetail
          key={entryKey(entry)}
          threadRef={threadRef}
          root={root}
          build={build}
          entry={entry}
          things={things}
          use={use}
          viewerUrl={viewerUrl}
          onAsk={onAsk}
          onBack={() => {
            hoverStageThing(null);
            setSelected(null);
          }}
        />
      )}
      {viewerUrl === null || wanted.length === 0 ? null : (
        <ArtThumbnailPainter
          viewerUrl={viewerUrl}
          wanted={wanted}
          onDrawn={(asset, png) => {
            setDrawn((before) => new Map(before).set(asset.sha256, png));
            if (png !== null)
              void keepThumbnail({
                environmentId: threadRef.environmentId,
                input: { threadId: threadRef.threadId, sha256: asset.sha256, png },
              });
          }}
        />
      )}
    </div>
  );
}

// ─── The list ───────────────────────────────────────────────────────────────────

const FILTERS: ReadonlyArray<{ readonly value: ArtFilter; readonly label: string }> = [
  { value: "all", label: "All" },
  { value: "model", label: "Models" },
  { value: "texture", label: "Textures" },
  { value: "audio", label: "Sounds" },
];

function ArtList({
  threadRef,
  root,
  build,
  assets,
  code,
  use,
  drawn,
  loading,
  more,
  onOpen,
}: {
  threadRef: ScopedThreadRef;
  root: string | null;
  build: string | null;
  assets: ReadonlyArray<GameArtAsset>;
  code: ReadonlyArray<GameArtCodeModel>;
  use: GameAssetUse | null;
  drawn: ReadonlyMap<string, string | null>;
  loading: boolean;
  more: number;
  onOpen: (entry: GameArtEntry) => void;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ArtFilter>("all");
  const shown = artSections(assets, code, search, filter);
  const nothing =
    shown.pictures.length === 0 && shown.sounds.length === 0 && shown.fonts.length === 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <StyleRow threadRef={threadRef} />
      <div className="flex flex-col gap-2 px-4 pt-3 pb-2">
        <Input
          size="sm"
          type="search"
          value={search}
          placeholder="Search"
          aria-label="Search the game's art"
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
        <ToggleGroup
          aria-label="Show"
          variant="segmented"
          value={[filter]}
          onValueChange={(next) => {
            const picked = FILTERS.find((each) => each.value === next[0]);
            if (picked !== undefined) setFilter(picked.value);
          }}
        >
          {FILTERS.map((each) => (
            <Toggle key={each.value} value={each.value}>
              {each.label}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
      {!loading && assets.length === 0 && code.length === 0 ? (
        <Workbench.Empty icon={<ImageIcon />} title="No art yet" />
      ) : nothing && search !== "" ? (
        <Text variant="body" tone="muted" render={<p className="px-4 py-3" />}>
          Nothing matches “{search}”.
        </Text>
      ) : (
        <div className="flex flex-col gap-4 pt-1 pb-4">
          {shown.pictures.length === 0 ? null : (
            <ul
              aria-label="Models and textures"
              className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-x-3 gap-y-3 px-4"
            >
              {shown.pictures.map((entry) => (
                <li key={entryKey(entry)} className="min-w-0">
                  <ArtTile
                    threadRef={threadRef}
                    root={root}
                    build={build}
                    entry={entry}
                    use={use}
                    drawn={drawn}
                    onOpen={onOpen}
                  />
                </li>
              ))}
            </ul>
          )}
          {shown.sounds.length === 0 || root === null ? null : (
            <ArtGroup label="Sounds" count={shown.sounds.length}>
              {shown.sounds.map((asset) => (
                <SoundRow
                  key={asset.path}
                  threadRef={threadRef}
                  root={root}
                  asset={asset}
                  unused={isUnused(asset, use)}
                  onOpen={() => onOpen({ kind: "file", asset })}
                />
              ))}
            </ArtGroup>
          )}
          {shown.fonts.length === 0 || root === null ? null : (
            <ArtGroup label="Fonts" count={shown.fonts.length}>
              {shown.fonts.map((asset) => (
                <FontRow
                  key={asset.path}
                  threadRef={threadRef}
                  root={root}
                  asset={asset}
                  onOpen={() => onOpen({ kind: "file", asset })}
                />
              ))}
            </ArtGroup>
          )}
          {more > 0 ? (
            <Text variant="caption" tone="muted" render={<p className="px-4" />}>
              {countWords(more, "more file", "more files")} not listed
            </Text>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** A list's heading with its count, then its rows. */
function ArtGroup({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="flex flex-col">
      <div className="flex h-7 items-center gap-2 px-4">
        <Text variant="meta" tone="muted">
          {label}
        </Text>
        <Text variant="caption" tone="dim" numeric>
          {count}
        </Text>
      </div>
      {children}
    </section>
  );
}

/** A decoded STYLE.json, the agent's record of the game's look. */
const decodeStyle = Schema.decodeUnknownOption(Schema.fromJsonString(GameStyle));

/**
 * A style family's slug as a person would say the look, without the asset pack's vendor:
 * "kenney-lowpoly" reads "Low-poly".
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

/** STYLE.json, when the game has one: its palette as swatches and its name, in one quiet row. */
function StyleRow({ threadRef }: { threadRef: ScopedThreadRef }) {
  const root = useIsGameThreadStatus(threadRef).data?.root ?? null;
  const file = useEnvironmentQuery(
    root === null
      ? null
      : projectEnvironment.readFile({
          environmentId: threadRef.environmentId,
          input: { cwd: root, relativePath: GAME_STYLE_FILE },
        }),
  );
  const style = file.data == null ? null : Option.getOrNull(decodeStyle(file.data.contents));
  if (style === null) return null;
  const swatches = Array.isArray(style.palette) ? style.palette : [];
  const name =
    style.family === undefined || style.family === null
      ? typeof style.palette === "string"
        ? style.palette
        : null
      : styleFamilyWords(style.family);
  if (swatches.length === 0 && name === null) return null;
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
      {swatches.length === 0 ? null : (
        <span className="flex gap-0.5">
          {swatches.slice(0, 8).map((hex) => (
            <span
              key={hex}
              aria-label={hex}
              className="size-3.5 rounded-sm ring-1 ring-border ring-inset"
              style={{ background: hex }}
            />
          ))}
        </span>
      )}
      {name === null ? null : (
        <Text variant="meta" tone="muted" truncate>
          {name}
        </Text>
      )}
    </div>
  );
}

/** Points the frozen Stage at what an asset is in the game, if it is there: the Tune list's hover. */
const stageThingOf = (entry: GameArtEntry, things: ReadonlyArray<GameThing>) =>
  entry.kind === "code-model" ? entry.id : (thingOfAsset(things, entry.asset)?.id ?? null);

/**
 * One model or texture: its square picture on the neutral surface, its name, and one fact under
 * it (a model's triangles, a texture's pixels). One the build's plays never loaded is dimmed.
 */
function ArtTile({
  threadRef,
  root,
  build,
  entry,
  use,
  drawn,
  onOpen,
}: {
  threadRef: ScopedThreadRef;
  root: string | null;
  build: string | null;
  entry: GameArtEntry;
  use: GameAssetUse | null;
  drawn: ReadonlyMap<string, string | null>;
  onOpen: (entry: GameArtEntry) => void;
}) {
  const [pixels, setPixels] = useState<string | null>(null);
  const facts = useThingFacts(threadRef, build, entry.kind === "code-model" ? entry.id : "");
  const unused = entry.kind === "file" && isUnused(entry.asset, use);
  const name = entry.kind === "file" ? fileName(entry.asset.path) : entry.name;
  const fact = unused
    ? "Unused"
    : entry.kind === "code-model"
      ? facts === null || facts.triangles === 0
        ? KIND_WORDS[entry.thingKind]
        : countWords(facts.triangles, "triangle", "triangles")
      : entry.asset.kind === "model"
        ? entry.asset.triangles === undefined
          ? bytesWords(entry.asset.bytes)
          : countWords(entry.asset.triangles, "triangle", "triangles")
        : (pixels ?? bytesWords(entry.asset.bytes));
  return (
    <button
      type="button"
      onClick={() => onOpen(entry)}
      onPointerEnter={() => {
        if (entry.kind === "code-model") hoverStageThing(entry.id);
      }}
      onPointerLeave={() => hoverStageThing(null)}
      className={cn(
        "group/tile flex w-full min-w-0 cursor-pointer flex-col gap-1.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        unused && "opacity-55",
      )}
    >
      <span className="relative block aspect-square w-full overflow-hidden rounded-md bg-muted ring-border ring-inset group-hover/tile:ring-1">
        {entry.kind === "code-model" ? (
          <GameThingPicture
            threadRef={threadRef}
            thing={{ id: entry.id, kind: entry.thingKind }}
            build={build}
            className="absolute inset-0 rounded-none bg-transparent"
          />
        ) : (
          <FilePicture
            threadRef={threadRef}
            root={root}
            asset={entry.asset}
            drawn={drawn}
            onPixels={setPixels}
          />
        )}
      </span>
      <span className="flex min-w-0 flex-col">
        <Text variant="meta" tone="default" truncate>
          {name}
        </Text>
        <Text variant="caption" tone="muted" numeric truncate>
          {fact}
        </Text>
      </span>
    </button>
  );
}

/** A file's picture: a model's thumbnail drawn once and kept by its content, or the image itself. */
function FilePicture({
  threadRef,
  root,
  asset,
  drawn,
  onPixels,
}: {
  threadRef: ScopedThreadRef;
  root: string | null;
  asset: GameArtAsset;
  drawn: ReadonlyMap<string, string | null>;
  onPixels: (pixels: string) => void;
}) {
  const glyph = (
    <span
      aria-hidden="true"
      className="absolute inset-0 flex items-center justify-center text-dim-foreground [&_svg]:size-5"
    >
      {asset.kind === "model" ? <ShapesIcon /> : <ImageIcon />}
    </span>
  );
  if (asset.kind === "texture")
    return root === null ? (
      glyph
    ) : (
      <TexturePicture threadRef={threadRef} root={root} asset={asset} onPixels={onPixels} />
    );
  const local = drawn.get(asset.sha256);
  if (local !== undefined && local !== null)
    return <img src={local} alt="" className="absolute inset-0 size-full object-contain" />;
  if (asset.thumbnail === undefined || root === null) return glyph;
  return (
    <GameKeyArt
      environmentId={threadRef.environmentId}
      root={root}
      path={asset.thumbnail}
      className="object-contain"
      missing={glyph}
    />
  );
}

/** A texture as its own picture, saying its size in pixels once it loads. */
function TexturePicture({
  threadRef,
  root,
  asset,
  onPixels,
}: {
  threadRef: ScopedThreadRef;
  root: string;
  asset: GameArtAsset;
  onPixels: (pixels: string) => void;
}) {
  const state = useAssetUrlState(threadRef.environmentId, {
    _tag: "draft-workspace-file",
    cwd: root,
    path: asset.path,
  });
  if (state._tag !== "Success") return null;
  return (
    <img
      src={state.url}
      alt=""
      decoding="async"
      loading="lazy"
      onLoad={(event) =>
        onPixels(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`)
      }
      className="absolute inset-0 size-full object-contain [image-rendering:pixelated]"
    />
  );
}

const WAVE_W = 120;
const WAVE_H = 20;
const WAVE_BARS = 40;

/** One sound: play, its name and length, its waveform, and "Unused" when no play used it. */
function SoundRow({
  threadRef,
  root,
  asset,
  unused,
  onOpen,
}: {
  threadRef: ScopedThreadRef;
  root: string;
  asset: GameArtAsset;
  unused: boolean;
  onOpen: () => void;
}) {
  const state = useAssetUrlState(threadRef.environmentId, {
    _tag: "draft-workspace-file",
    cwd: root,
    path: asset.path,
  });
  const url = state._tag === "Success" ? state.url : null;
  const wave = useSoundPeaks(url, asset.sha256);
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const peaks =
    wave === null || wave === "failed"
      ? []
      : Array.from({ length: WAVE_BARS }, (_, bar) => {
          const from = Math.floor((bar / WAVE_BARS) * wave.peaks.length);
          const to = Math.max(from + 1, Math.floor(((bar + 1) / WAVE_BARS) * wave.peaks.length));
          return Math.max(...wave.peaks.slice(from, to), 0.02);
        });
  return (
    <div className={cn("flex h-9 min-w-0 items-center gap-2 ps-2 pe-4", unused && "opacity-55")}>
      <Button
        size="icon-sm"
        variant="ghost"
        disabled={url === null}
        aria-label={playing ? `Pause ${fileName(asset.path)}` : `Play ${fileName(asset.path)}`}
        onClick={() => {
          if (audio.current === null) return;
          if (playing) audio.current.pause();
          else void audio.current.play();
        }}
      >
        {playing ? <PauseIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}
      </Button>
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <Text variant="meta" tone="default" truncate render={<span className="flex-1" />}>
          {fileName(asset.path)}
        </Text>
        <Text variant="caption" tone="muted" numeric render={<span className="shrink-0" />}>
          {wave === null || wave === "failed" ? "" : clipTime(wave.seconds)}
        </Text>
        <svg
          viewBox={`0 0 ${WAVE_W} ${WAVE_H}`}
          width={WAVE_W}
          height={WAVE_H}
          aria-hidden="true"
          className="shrink-0"
        >
          {peaks.map((peak, index) => (
            <rect
              // oxlint-disable-next-line react/no-array-index-key -- a bar is its slice of the sound.
              key={index}
              x={(index * WAVE_W) / WAVE_BARS + 0.5}
              width={WAVE_W / WAVE_BARS - 1}
              y={(WAVE_H - peak * WAVE_H) / 2}
              height={Math.max(1, peak * WAVE_H)}
              rx={0.5}
              className="fill-muted-foreground"
            />
          ))}
        </svg>
        {unused ? (
          <Text variant="caption" tone="muted" render={<span className="w-11 shrink-0" />}>
            Unused
          </Text>
        ) : (
          <span className="w-11 shrink-0" />
        )}
      </button>
      {url === null ? null : (
        <audio
          ref={audio}
          src={url}
          preload="none"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />
      )}
    </div>
  );
}

/** One font: its name, then a line set in it. */
function FontRow({
  threadRef,
  root,
  asset,
  onOpen,
}: {
  threadRef: ScopedThreadRef;
  root: string;
  asset: GameArtAsset;
  onOpen: () => void;
}) {
  const family = useFontFamily(threadRef.environmentId, root, asset);
  return (
    <div className="px-2">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full min-w-0 cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left outline-none hover:surface-selected-soft focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <Text variant="caption" tone="muted" truncate>
          {fileName(asset.path)}
        </Text>
        <span
          className="min-w-0 truncate text-foreground"
          // The font's own face at one sample size: no type role, which would set its own.
          style={{
            fontSize: 20,
            lineHeight: "28px",
            ...(family === null || family === "failed" ? { opacity: 0 } : { fontFamily: family }),
          }}
        >
          {FONT_SAMPLE}
        </span>
      </button>
    </div>
  );
}

// ─── One asset ──────────────────────────────────────────────────────────────────

const LOOK_TINT: GameThingValue = {
  key: "tint",
  value: 0xffffff,
  default: 0xffffff,
  min: 0,
  max: 0xffffff,
  step: 1,
  label: "Tint",
  colour: true,
};
const LOOK_SCALE: GameThingValue = {
  key: "scale",
  value: 1,
  default: 1,
  min: 0.1,
  max: 10,
  step: 0.05,
  unit: "×",
};

/** What the agent is told about an asset with the chip. */
const assetContext = (
  entry: GameArtEntry,
  info: ViewerModelInfo | null,
  facts: GameThingFacts | null,
) => {
  if (entry.kind === "code-model")
    return [
      `The model "${entry.name}" that the game's code builds (a named thing on the Stage, id \`${entry.id}\`).`,
      facts === null
        ? null
        : `As the game draws it: ${facts.triangles} triangles, ${facts.materials} materials (${facts.colours.join(", ") || "no base colours"}), ${facts.size.join(" × ")} units. The picture is it alone, from the Art view's angle.`,
    ]
      .filter((line) => line !== null)
      .join("\n");
  const asset = entry.asset;
  return [
    `The asset \`${asset.path}\` (${asset.kind}, ${bytesWords(asset.bytes)}${asset.triangles === undefined ? "" : `, ${asset.triangles} triangles`}).`,
    `Where it came from: ${ROUTE_WORDS[asset.route]}${asset.pack === undefined ? "" : ` (library pack ${asset.pack})`}${asset.generations === undefined ? "" : ` (generation ${asset.generations.join(", ")})`}.`,
    asset.sidecar === undefined ? null : `Its sidecar: \`${asset.sidecar}\`.`,
    asset.note === undefined ? null : `ASSETS.md says: ${asset.note}`,
    info === null
      ? null
      : `In the viewer: ${info.size.join(" × ")} m, ${info.materials.length} materials, ${info.textures.length} textures, ${info.clips.length} clips${info.bones > 0 ? `, ${info.bones} bones` : ""}. The picture is the viewer's current angle.`,
  ]
    .filter((line) => line !== null)
    .join("\n");
};

function ArtDetail({
  threadRef,
  root,
  build,
  entry,
  things,
  use,
  viewerUrl,
  onAsk,
  onBack,
}: {
  threadRef: ScopedThreadRef;
  root: string;
  build: string | null;
  entry: GameArtEntry;
  things: ReadonlyArray<GameThing>;
  use: GameAssetUse | null;
  viewerUrl: string | null;
  onAsk: (text: string) => void;
  onBack: () => void;
}) {
  const [info, setInfo] = useState<ViewerModelInfo | null>(null);
  const [handle, setHandle] = useState<ModelViewerHandle | null>(null);
  // The code-made thing's view as last drawn: the chip's picture and its facts.
  const [orbit, setOrbit] = useState<{ png: string; facts: GameThingFacts | null } | null>(null);
  const name = entry.kind === "file" ? fileName(entry.asset.path) : entry.name;
  const stageId = stageThingOf(entry, things);
  const stageThing =
    stageId === null ? null : (things.find((thing) => thing.id === stageId) ?? null);
  // Outlined on a frozen Stage for as long as it is open here.
  useEffect(() => {
    if (stageId === null) return;
    hoverStageThing(stageId);
    return () => {
      hoverStageThing(null);
    };
  }, [stageId]);
  const ask = async () => {
    const png =
      entry.kind === "code-model"
        ? (orbit?.png ?? null)
        : handle === null
          ? null
          : await handle.picture();
    await attachAssetToComposer(
      threadRef,
      {
        key: entryKey(entry),
        label: name,
        context: assetContext(entry, info, orbit?.facts ?? null),
      },
      png,
    );
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex h-11 shrink-0 items-center gap-1 ps-2 pe-2">
        <Tooltip>
          <TooltipTrigger
            render={<Button size="icon-sm" variant="ghost" aria-label="All art" onClick={onBack} />}
          >
            <ChevronLeftIcon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">All art</TooltipPopup>
        </Tooltip>
        <Text variant="label" tone="strong" truncate render={<h3 className="min-w-0 flex-1" />}>
          {name}
        </Text>
        {stageThing === null || !stageThing.onScreen ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Show on the Stage"
                  onClick={() => pointAtStageThing(stageThing.id)}
                />
              }
            >
              <CrosshairIcon aria-hidden="true" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Show on the Stage</TooltipPopup>
          </Tooltip>
        )}
        <Button size="sm" variant="ghost" onClick={() => void ask()}>
          <MessageSquarePlusIcon aria-hidden="true" />
          Ask about this
        </Button>
      </div>
      {entry.kind === "code-model" ? (
        <CodeModelDetail
          threadRef={threadRef}
          build={build}
          entry={entry}
          onDrawn={setOrbit}
          facts={orbit?.facts ?? null}
        />
      ) : (
        <FileDetail
          threadRef={threadRef}
          root={root}
          asset={entry.asset}
          stageThing={stageThing}
          use={use}
          viewerUrl={viewerUrl}
          info={info}
          onInfo={setInfo}
          onHandle={setHandle}
          handle={handle}
          onAsk={onAsk}
        />
      )}
    </div>
  );
}

const ORBIT_PX = 384;
const ORBIT_PER_PX = 0.012;

/**
 * A thing the game's code makes, seen alone: the game draws it from the angle dragged here, one
 * picture at a time, then what it is made of and, when it has values, Tune on it.
 */
function CodeModelDetail({
  threadRef,
  build,
  entry,
  facts,
  onDrawn,
}: {
  threadRef: ScopedThreadRef;
  build: string | null;
  entry: GameArtCodeModel;
  facts: GameThingFacts | null;
  onDrawn: (view: { png: string; facts: GameThingFacts | null }) => void;
}) {
  const [angle, setAngle] = useState({ yaw: 0.7, pitch: 0.55 });
  const [picture, setPicture] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const drag = useRef<{ x: number; y: number } | null>(null);
  // One picture in flight; the angle asked for meanwhile is drawn after it.
  const busy = useRef(false);
  const wanted = useRef(angle);
  const draw = useStableCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    let asked = wanted.current;
    for (;;) {
      const portrait = await portraitStageThing(entry.id, { size: ORBIT_PX, ...asked });
      if (portrait === null) setFailed(true);
      else {
        setFailed(false);
        setPicture(portrait.png);
        onDrawn({ png: portrait.png, facts: portrait.facts ?? null });
      }
      if (wanted.current === asked) break;
      asked = wanted.current;
    }
    busy.current = false;
  });
  useEffect(() => {
    wanted.current = angle;
    void draw();
  }, [angle, draw]);
  return (
    <>
      <div
        role="img"
        aria-label={`${entry.name}, drag to turn it`}
        className="relative aspect-square w-full shrink-0 cursor-grab touch-none bg-stage-well active:cursor-grabbing"
        onPointerDown={(event) => {
          drag.current = { x: event.clientX, y: event.clientY };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const from = drag.current;
          if (from === null) return;
          const dx = event.clientX - from.x;
          const dy = event.clientY - from.y;
          if (Math.abs(dx) + Math.abs(dy) < 3) return;
          drag.current = { x: event.clientX, y: event.clientY };
          setAngle((before) => ({
            yaw: before.yaw - dx * ORBIT_PER_PX,
            pitch: Math.max(-1.3, Math.min(1.3, before.pitch + dy * ORBIT_PER_PX)),
          }));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
      >
        {picture === null ? (
          <GameThingPicture
            threadRef={threadRef}
            thing={{ id: entry.id, kind: entry.thingKind }}
            build={build}
            className="absolute inset-0 rounded-none bg-transparent"
          />
        ) : (
          <img
            src={picture}
            alt=""
            draggable={false}
            className="absolute inset-0 size-full object-contain select-none"
          />
        )}
        {failed && picture === null ? (
          <Text
            variant="caption"
            tone="muted"
            render={<span className="pointer-events-none absolute start-4 bottom-3" />}
          >
            Play the game to see it
          </Text>
        ) : null}
      </div>
      <Workbench.Body className="overflow-visible">
        <Workbench.Section title="Model">
          <ArtFact name="Kind" reading={KIND_WORDS[entry.thingKind]} />
          {facts === null ? null : (
            <>
              <ArtFact name="Triangles" reading={facts.triangles.toLocaleString("en-US")} />
              <ArtFact name="Size" reading={`${facts.size.join(" × ")} (wide × tall × long)`} />
              <ArtFact
                name="Materials"
                reading={<MaterialSwatches count={facts.materials} colours={facts.colours} />}
              />
            </>
          )}
        </Workbench.Section>
        {entry.tunable ? (
          <div className="px-4 py-3">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                selectStageThing(entry.id);
                showWorkbench("tune");
              }}
            >
              <SlidersHorizontalIcon aria-hidden="true" />
              Tune its values
            </Button>
          </div>
        ) : null}
      </Workbench.Body>
    </>
  );
}

/** One fact of an asset: its name and its reading at the right, on the panel's 16 px edges. */
function ArtFact({
  mark,
  name,
  reading,
}: {
  mark?: ReactNode;
  name: ReactNode;
  reading?: ReactNode;
}) {
  return (
    <div className="flex min-h-7 min-w-0 items-start gap-2 px-4 py-1">
      {mark === undefined ? null : (
        <span className="flex h-5 w-3.5 shrink-0 items-center justify-center">{mark}</span>
      )}
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3">
        <Text variant="meta" tone="default" render={<span className="min-w-0 leading-5" />}>
          {name}
        </Text>
        <span aria-hidden="true" className="flex-1" />
        {reading === undefined ? null : (
          <Text
            variant="caption"
            tone="muted"
            numeric
            render={<span className="min-w-0 leading-5" />}
          >
            {reading}
          </Text>
        )}
      </span>
    </div>
  );
}

/** A game path that breaks only after its slashes, the folders quieter than the file. */
function AssetPath({ path }: { path: string }) {
  const parts = path.split("/");
  const file = parts.pop() ?? path;
  return (
    <Text variant="caption" tone="muted" render={<p className="px-4 pb-1" />}>
      {parts.map((part, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- a folder is its place in the path.
        <span key={index}>
          {part}/<wbr />
        </span>
      ))}
      <span className="text-foreground">{file}</span>
    </Text>
  );
}

function FileDetail({
  threadRef,
  root,
  asset,
  stageThing,
  use,
  viewerUrl,
  info,
  onInfo,
  handle,
  onHandle,
  onAsk,
}: {
  threadRef: ScopedThreadRef;
  root: string;
  asset: GameArtAsset;
  stageThing: GameThing | null;
  use: GameAssetUse | null;
  viewerUrl: string | null;
  info: ViewerModelInfo | null;
  onInfo: (info: ViewerModelInfo | null) => void;
  handle: ModelViewerHandle | null;
  onHandle: (handle: ModelViewerHandle | null) => void;
  onAsk: (text: string) => void;
}) {
  // The asset's look values as the game on the Stage holds them: ASSETS models carry them.
  const lookValues = (stageThing?.values ?? []).filter(
    (value) => (value.key === "tint" && value.colour === true) || value.key === "scale",
  );
  const tint = lookValues.find((value) => value.key === "tint")?.value;
  const scale = lookValues.find((value) => value.key === "scale")?.value;
  const look = {
    tint: typeof tint === "number" ? tint : 0xffffff,
    scale: typeof scale === "number" ? scale : 1,
  };
  const usedWords = inPlayWords(asset, use, stageThing !== null);
  return (
    <>
      {asset.kind === "model" ? (
        viewerUrl === null ? (
          <Workbench.Empty icon={<ShapesIcon />} title="Play the game to open its models" />
        ) : (
          <ModelViewer
            viewerUrl={viewerUrl}
            asset={asset}
            look={look}
            onInfo={onInfo}
            handle={onHandle}
          />
        )
      ) : asset.kind === "texture" ? (
        <TextureViewer environmentId={threadRef.environmentId} root={root} asset={asset} />
      ) : asset.kind === "audio" ? (
        <AudioViewer environmentId={threadRef.environmentId} root={root} asset={asset} />
      ) : (
        <FontViewer environmentId={threadRef.environmentId} root={root} asset={asset} />
      )}
      <Workbench.Body className="overflow-visible">
        <Workbench.Section title="File" detail={bytesWords(asset.bytes)}>
          <AssetPath path={asset.path} />
          {asset.route === "unrecorded" ? null : (
            <ArtFact
              name="From"
              reading={
                asset.route === "library" && asset.pack !== undefined
                  ? `Library · ${asset.pack}`
                  : ROUTE_WORDS[asset.route]
              }
            />
          )}
          {asset.credit === undefined ? null : <ArtFact name="Licence" reading={asset.credit} />}
          {usedWords === null ? null : <ArtFact name="In play" reading={usedWords} />}
        </Workbench.Section>
        {asset.kind === "model" && info !== null ? <ModelFacts info={info} /> : null}
        {asset.kind === "model" && stageThing !== null && lookValues.length > 0 ? (
          <ModelLook threadRef={threadRef} asset={asset} values={lookValues} handle={handle} />
        ) : null}
        <GenerateAgain threadRef={threadRef} asset={asset} onAsk={onAsk} />
      </Workbench.Body>
    </>
  );
}

/** A texture's place in its material as a person says it, not three.js's property name. */
const SLOT_WORDS: Readonly<Record<string, string>> = {
  map: "Colour",
  normalMap: "Normal",
  roughnessMap: "Roughness",
  metalnessMap: "Metalness",
  emissiveMap: "Glow",
  aoMap: "Occlusion",
  alphaMap: "Alpha",
  bumpMap: "Bump",
  displacementMap: "Height",
  lightMap: "Light",
  envMap: "Reflection",
  specularMap: "Specular",
};
const slotWords = (slot: string) =>
  SLOT_WORDS[slot] ?? `${slot.charAt(0).toUpperCase()}${slot.slice(1).replace(/Map$/, "")}`;

/** "2 · ■ ■": how many materials, and each one's base colour. */
function MaterialSwatches({ count, colours }: { count: number; colours: ReadonlyArray<string> }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {count}
      {colours.length === 0 ? null : (
        <>
          <span aria-hidden="true">·</span>
          {colours.map((colour, index) => (
            <span
              // oxlint-disable-next-line react/no-array-index-key -- two materials may share a colour.
              key={`${index}:${colour}`}
              aria-label={colour}
              className="size-3 rounded-sm ring-1 ring-border ring-inset"
              style={{ backgroundColor: colour }}
            />
          ))}
        </>
      )}
    </span>
  );
}

function ModelFacts({ info }: { info: ViewerModelInfo }) {
  return (
    <>
      <Workbench.Section title="Model">
        <ArtFact name="Triangles" reading={info.triangles.toLocaleString("en-US")} />
        <ArtFact name="Draw calls" reading={info.drawCalls} />
        <ArtFact name="Size" reading={`${info.size.join(" × ")} m (wide × tall × long)`} />
        <ArtFact
          name="Pivot"
          reading={`origin; bounds y ${info.bounds[0][1]} to ${info.bounds[1][1]} m`}
        />
        <ArtFact
          name="Skeleton"
          reading={info.bones === 0 ? "None" : countWords(info.bones, "bone", "bones")}
        />
        <ArtFact
          name="Clips"
          reading={
            info.clips.length === 0 ? "None" : countWords(info.clips.length, "clip", "clips")
          }
        />
        <ArtFact
          name="Materials"
          reading={
            <MaterialSwatches
              count={info.materials.length}
              colours={info.materials.flatMap((material) =>
                material.color === undefined ? [] : [material.color],
              )}
            />
          }
        />
      </Workbench.Section>
      {info.textures.length === 0 ? null : (
        <Workbench.Section title="Textures" detail={info.textures.length}>
          {info.textures.map((texture, index) => (
            <ArtFact
              // oxlint-disable-next-line react/no-array-index-key -- two textures may share a name.
              key={`${index}:${texture.name}`}
              name={texture.name === texture.slot ? slotWords(texture.slot) : texture.name}
              reading={`${slotWords(texture.slot)} · ${texture.width} × ${texture.height}`}
            />
          ))}
        </Workbench.Section>
      )}
    </>
  );
}

/**
 * Tint and scale, written as the model's tune values (tune.json, by its path) through Tune's own
 * saver, so each change is a build Undo takes back. They play on the Stage as they move.
 */
function ModelLook({
  threadRef,
  asset,
  values,
  handle,
}: {
  threadRef: ScopedThreadRef;
  asset: GameArtAsset;
  values: ReadonlyArray<GameThingValue>;
  handle: ModelViewerHandle | null;
}) {
  const saver = useTuneSaver(threadRef);
  const id = asset.path;
  const tunes = [LOOK_TINT, LOOK_SCALE].map((base) => {
    const live = values.find((value) => value.key === base.key);
    return live === undefined ? base : { ...base, value: live.value };
  });
  return (
    <Workbench.Section title="Tint and scale">
      {tunes.map((value) => (
        <GameTuneField
          key={value.key}
          label={value.key === "tint" ? "Tint" : "Scale"}
          value={value}
          was={value.value === value.default ? undefined : value.default}
          disabled={!saver.canSave}
          onChange={(next) => {
            tuneStageValue(id, value.key, next);
            handle?.look({ [value.key]: next });
          }}
          onCommit={(next) => saver.save(id, { ...value, value: next }, "keyboard")}
          onReset={() => {
            if (value.default === undefined) return;
            tuneStageValue(id, value.key, value.default);
            handle?.look({ [value.key]: value.default });
            saver.save(id, { ...value, value: value.default }, "keyboard");
          }}
        />
      ))}
    </Workbench.Section>
  );
}

/** A generated file's prompt, to edit and generate again; nothing for any other file. */
function GenerateAgain({
  threadRef,
  asset,
  onAsk,
}: {
  threadRef: ScopedThreadRef;
  asset: GameArtAsset;
  onAsk: (text: string) => void;
}) {
  const generations = useGameGenerations(threadRef).data?.generations ?? [];
  const generation =
    generations.find(
      (each) =>
        asset.generations?.includes(each.id) === true ||
        each.files.includes(asset.path) ||
        (asset.sidecar !== undefined && each.files.includes(asset.sidecar)),
    ) ?? null;
  const [prompt, setPrompt] = useState<string | null>(null);
  if (generation === null) return null;
  const text = prompt ?? generation.prompt;
  return (
    <Workbench.Section title="Prompt" detail={generation.provider}>
      <div className="flex flex-col gap-2 px-4 pt-1">
        <Textarea
          size="sm"
          value={text}
          onChange={(event) => setPrompt(event.currentTarget.value)}
          aria-label="Prompt"
          rows={3}
        />
        <div className="flex">
          <Button
            size="sm"
            variant="secondary"
            disabled={text.trim() === ""}
            onClick={() =>
              onAsk(
                `Generate ${asset.path} again with game_art (my keys, the same kind and provider, ${generation.provider}) from this prompt, then put the new one in the game in its place:\n\n${text.trim()}`,
              )
            }
          >
            Generate again
          </Button>
        </div>
      </div>
    </Workbench.Section>
  );
}
