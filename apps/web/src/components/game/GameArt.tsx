import { useEffect, useState, type ReactNode } from "react";
import { LegendList } from "@legendapp/list/react";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  GAME_STYLE_FILE,
  GameStyle,
  manifestRuntime,
  type GameArtAsset,
  type GameAssetUse,
  type GameThing,
  type GameThingValue,
  type ScopedThreadRef,
} from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import {
  AudioLinesIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  CrosshairIcon,
  ImageIcon,
  MessageSquarePlusIcon,
  ShapesIcon,
  TypeIcon,
} from "lucide-react";

import { useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { cn } from "../../lib/utils";
import { gameEnvironment } from "../../state/game";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Text } from "../ui/text";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  ArtThumbnailPainter,
  AudioViewer,
  FontViewer,
  ModelViewer,
  TextureViewer,
  type ModelViewerHandle,
  type ViewerModelInfo,
} from "./GameArtViewers";
import { GameCharacterRoutePicker } from "./GameCharacterRoute";
import { GameGeneratedArt } from "./GameGeneratedArt";
import { useChoosingCount, useGameGenerations, useGenerationCount } from "./GameGenerationCard";
import { GameKeyArt } from "./GameKeyArt";
import { GameTuneField } from "./GameTuneField";
import { useTuneSaver } from "./GameTune";
import { Workbench } from "./GameWorkbenchParts";
import {
  artRows,
  assetSummary,
  bytesWords,
  CODE_MODEL_PREFIX,
  codeModels,
  countWords,
  entryKey,
  fileName,
  ROUTE_WORDS,
  thingOfAsset,
  useWords,
  type GameArtCodeModel,
  type GameArtEntry,
  type GameArtRow,
} from "./gameArt.logic";
import { refOf } from "./gameBuildRef";
import { attachAssetToComposer } from "./gameComposerContext";
import {
  hoverStageThing,
  selectStageThing,
  tuneStageValue,
  useThreadStageBridge,
} from "./gameStageBridge";

const NO_THINGS: ReadonlyArray<GameThing> = [];
const NO_ASSETS: ReadonlyArray<GameArtAsset> = [];
const ROW_HEIGHT = 52;
const HEADING_HEIGHT = 32;

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
 * The Workbench's Art: the game's look, then every asset it has (models, textures and sprites,
 * sounds, fonts, and the models its code makes), grouped by kind with search. Opening one shows
 * it in a viewer of its kind with what it holds, where it came from, and the ways to change it.
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
          assets={assets}
          code={code}
          things={things}
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
          entry={entry}
          things={things}
          use={use}
          viewerUrl={viewerUrl}
          blend={read.data?.blend ?? null}
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

function ArtList({
  threadRef,
  assets,
  code,
  things,
  use,
  drawn,
  loading,
  more,
  onOpen,
}: {
  threadRef: ScopedThreadRef;
  assets: ReadonlyArray<GameArtAsset>;
  code: ReadonlyArray<GameArtCodeModel>;
  things: ReadonlyArray<GameThing>;
  use: GameAssetUse | null;
  drawn: ReadonlyMap<string, string | null>;
  loading: boolean;
  more: number;
  onOpen: (entry: GameArtEntry) => void;
}) {
  const [search, setSearch] = useState("");
  const rows = artRows(assets, code, search);
  const root = useIsGameThreadStatus(threadRef).data?.root ?? null;
  const header = (
    <div className="flex flex-col">
      <ArtLook threadRef={threadRef} />
      <div className="flex items-center border-t border-border px-4 py-3">
        <Input
          size="sm"
          type="search"
          value={search}
          placeholder="Search the game's art"
          aria-label="Search the game's art"
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
      </div>
    </div>
  );
  if (!loading && assets.length === 0 && code.length === 0)
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <ArtLook threadRef={threadRef} />
        <Workbench.Empty
          icon={<ImageIcon />}
          title="No art yet"
          body="Models, textures, sounds and fonts the game holds show here, and models its code makes while it plays."
        />
      </div>
    );
  return (
    <LegendList<GameArtRow>
      data={rows}
      keyExtractor={(row) => row.key}
      getItemType={(row) => row.type}
      getFixedItemSize={(row) => (row.type === "heading" ? HEADING_HEIGHT : ROW_HEIGHT)}
      estimatedItemSize={ROW_HEIGHT}
      drawDistance={ROW_HEIGHT * 6}
      ListHeaderComponent={header}
      ListFooterComponent={
        more > 0 ? (
          <Text variant="caption" tone="muted" render={<p className="px-4 py-3" />}>
            {countWords(more, "more file", "more files")} not listed
          </Text>
        ) : rows.length === 0 && search !== "" ? (
          <Text variant="body" tone="muted" render={<p className="px-4 py-3" />}>
            Nothing matches “{search}”.
          </Text>
        ) : (
          <div className="h-2" />
        )
      }
      className="min-h-0 flex-1"
      renderItem={({ item }) =>
        item.type === "heading" ? (
          <div className="flex h-8 items-end gap-2 px-4 pb-1">
            <Text variant="caption" tone="muted">
              {item.label}
            </Text>
            <Text variant="caption" tone="dim" numeric>
              {item.count}
            </Text>
          </div>
        ) : (
          <ArtRowButton
            threadRef={threadRef}
            root={root}
            entry={item.entry}
            things={things}
            use={use}
            drawn={drawn}
            onOpen={onOpen}
          />
        )
      }
    />
  );
}

/** Points the frozen Stage at what an asset is in the game, if it is there: the Tune list's hover. */
const stageThingOf = (entry: GameArtEntry, things: ReadonlyArray<GameThing>) =>
  entry.kind === "code-model" ? entry.id : (thingOfAsset(things, entry.asset)?.id ?? null);

function ArtRowButton({
  threadRef,
  root,
  entry,
  things,
  use,
  drawn,
  onOpen,
}: {
  threadRef: ScopedThreadRef;
  root: string | null;
  entry: GameArtEntry;
  things: ReadonlyArray<GameThing>;
  use: GameAssetUse | null;
  drawn: ReadonlyMap<string, string | null>;
  onOpen: (entry: GameArtEntry) => void;
}) {
  const name = entry.kind === "file" ? fileName(entry.asset.path) : entry.name;
  const summary =
    entry.kind === "file" ? assetSummary(entry.asset, use) : "Code · made while the game plays";
  const stageId = stageThingOf(entry, things);
  return (
    <div className="px-2">
      <button
        type="button"
        onClick={() => onOpen(entry)}
        onPointerEnter={() => {
          if (stageId !== null) hoverStageThing(stageId);
        }}
        onPointerLeave={() => hoverStageThing(null)}
        className="flex h-12 w-full min-w-0 cursor-pointer items-center gap-3 rounded-md px-2 text-left outline-none hover:surface-selected-soft focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <ArtThumb threadRef={threadRef} root={root} entry={entry} drawn={drawn} />
        <span className="flex min-w-0 flex-1 flex-col">
          <Text variant="body" tone="default" truncate>
            {name}
          </Text>
          <Text variant="caption" tone="muted" numeric truncate>
            {summary}
          </Text>
        </span>
      </button>
    </div>
  );
}

/**
 * A row's picture: a model's thumbnail drawn once and kept by its content, an image itself, or the
 * kind's glyph on the neutral surface. Nothing here draws live.
 */
function ArtThumb({
  threadRef,
  root,
  entry,
  drawn,
}: {
  threadRef: ScopedThreadRef;
  root: string | null;
  entry: GameArtEntry;
  drawn: ReadonlyMap<string, string | null>;
}) {
  const glyph = (icon: ReactNode) => (
    <span
      aria-hidden="true"
      className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-dim-foreground [&_svg]:size-4"
    >
      {icon}
    </span>
  );
  if (entry.kind === "code-model") return glyph(<ShapesIcon />);
  const asset = entry.asset;
  if (asset.kind === "audio") return glyph(<AudioLinesIcon />);
  if (asset.kind === "font") return glyph(<TypeIcon />);
  const local = asset.kind === "model" ? drawn.get(asset.sha256) : undefined;
  const path = asset.kind === "texture" ? asset.path : (asset.thumbnail ?? null);
  if (local !== undefined && local !== null)
    return (
      <span className="relative size-9 shrink-0 overflow-hidden rounded-md bg-muted">
        <img src={local} alt="" className="absolute inset-0 size-full object-contain" />
      </span>
    );
  if (path === null || root === null) return glyph(<ShapesIcon />);
  return (
    <span className="relative size-9 shrink-0 overflow-hidden rounded-md bg-muted">
      <GameKeyArt
        environmentId={threadRef.environmentId}
        root={root}
        path={path}
        className="object-contain [image-rendering:pixelated]"
        missing={glyph(asset.kind === "model" ? <ShapesIcon /> : <ImageIcon />)}
      />
    </span>
  );
}

// ─── The look (the old Look panel) ───────────────────────────────────────────────

const decodeStyle = Schema.decodeUnknownOption(Schema.fromJsonString(GameStyle));

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

/** STYLE.json's family and palette, how models are made and whether the library may come in, and the generated art. */
function ArtLook({ threadRef }: { threadRef: ScopedThreadRef }) {
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
  return (
    <Workbench.Section title="Look">
      <div className="flex min-h-8 items-center gap-2 ps-4 pe-4">
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
            <Text variant="caption" tone="muted" truncate>
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
      <div className="flex min-h-8 items-center gap-2 ps-4 pe-2">
        <Text variant="body" tone="default" render={<span className="flex-1" />}>
          Models
        </Text>
        <GameCharacterRoutePicker threadRef={threadRef} />
      </div>
      <div className="px-2">
        <button
          type="button"
          aria-expanded={artOpen}
          onClick={() => setArtOpen(!artOpen)}
          className="flex min-h-8 w-full items-center gap-2 rounded-md ps-2 pe-2 text-left outline-none hover:surface-selected-soft focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
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
            <Text variant="caption" tone="muted" numeric>
              {generated === 0 ? "None yet" : generated === 1 ? "1 piece" : `${generated} pieces`}
            </Text>
          )}
          <ChevronDownIcon
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
              artOpen && "rotate-180",
            )}
            aria-hidden="true"
          />
        </button>
      </div>
      {style === null ? (
        <Text variant="caption" tone="muted" render={<p className="px-4" />}>
          The agent writes {GAME_STYLE_FILE} when it picks a look.
        </Text>
      ) : null}
      {artOpen ? (
        <div className="px-4 pt-2">
          <GameGeneratedArt threadRef={threadRef} />
        </div>
      ) : null}
    </Workbench.Section>
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
const assetContext = (entry: GameArtEntry, info: ViewerModelInfo | null) => {
  if (entry.kind === "code-model")
    return `The model "${entry.name}" that the game's code builds (a named thing on the Stage, id \`${entry.id}\`).`;
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
  entry,
  things,
  use,
  viewerUrl,
  blend,
  onAsk,
  onBack,
}: {
  threadRef: ScopedThreadRef;
  root: string;
  entry: GameArtEntry;
  things: ReadonlyArray<GameThing>;
  use: GameAssetUse | null;
  viewerUrl: string | null;
  blend: string | null;
  onAsk: (text: string) => void;
  onBack: () => void;
}) {
  const [info, setInfo] = useState<ViewerModelInfo | null>(null);
  const [handle, setHandle] = useState<ModelViewerHandle | null>(null);
  const name = entry.kind === "file" ? fileName(entry.asset.path) : entry.name;
  const label = entry.kind === "file" ? fileName(entry.asset.path) : entry.name;
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
    const png = handle === null ? null : await handle.picture();
    await attachAssetToComposer(
      threadRef,
      { key: entryKey(entry), label, context: assetContext(entry, info) },
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
        {stageThing === null ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Point at it on the Stage"
                  onClick={() => selectStageThing(stageThing.id)}
                />
              }
            >
              <CrosshairIcon aria-hidden="true" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Point at it on the Stage</TooltipPopup>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Ask the agent about this"
                onClick={() => void ask()}
              />
            }
          >
            <MessageSquarePlusIcon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Ask the agent about this: a chip with this view</TooltipPopup>
        </Tooltip>
      </div>
      {entry.kind === "code-model" ? (
        <CodeModelDetail entry={entry} onAsk={onAsk} />
      ) : (
        <FileDetail
          threadRef={threadRef}
          root={root}
          asset={entry.asset}
          stageThing={stageThing}
          use={use}
          viewerUrl={viewerUrl}
          blend={blend}
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

function CodeModelDetail({
  entry,
  onAsk,
}: {
  entry: GameArtCodeModel;
  onAsk: (text: string) => void;
}) {
  return (
    <Workbench.Body className="overflow-visible">
      <Workbench.Section title="Where it comes from">
        <Workbench.Row name="Made by the game's code while it plays" reading="Code" />
        <Text variant="caption" tone="muted" render={<p className="px-4 pt-1" />}>
          It has no file to open here. Point at it on the frozen Stage to see it, or Tune its
          values.
        </Text>
      </Workbench.Section>
      <Workbench.Section title="Change it">
        <ActionRow>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onAsk(`Change the model "${entry.name}" that the code builds: `)}
          >
            Ask the agent to change it
          </Button>
        </ActionRow>
      </Workbench.Section>
    </Workbench.Body>
  );
}

function ActionRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 px-4 py-1">{children}</div>;
}

function FileDetail({
  threadRef,
  root,
  asset,
  stageThing,
  use,
  viewerUrl,
  blend,
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
  blend: string | null;
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
  const usedWords = useWords(asset, use);
  return (
    <>
      {asset.kind === "model" ? (
        viewerUrl === null ? (
          <Workbench.Empty
            icon={<ShapesIcon />}
            title="Play the game to open its models"
            body="The viewer opens models from the game's own server, which runs while the game is on the Stage."
          />
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
          <Workbench.Row name={<span className="break-all">{asset.path}</span>} />
          <Workbench.Row
            name="From"
            reading={
              asset.route === "library" && asset.pack !== undefined
                ? `Library · ${asset.pack}`
                : ROUTE_WORDS[asset.route]
            }
          />
          {asset.credit === undefined ? null : (
            <Workbench.Row name="Licence" reading={asset.credit} />
          )}
          <Workbench.Row name="In play" reading={usedWords ?? "Not measured for this build"} />
          {asset.note === undefined ? null : (
            <Text variant="caption" tone="muted" render={<p className="px-4 pt-1" />}>
              {asset.note}
            </Text>
          )}
        </Workbench.Section>
        {asset.kind === "model" && info !== null ? <ModelFacts info={info} /> : null}
        {asset.kind === "model" ? (
          <ModelLook
            threadRef={threadRef}
            asset={asset}
            stageThing={stageThing}
            values={lookValues}
            handle={handle}
          />
        ) : null}
        <ChangeIt threadRef={threadRef} root={root} asset={asset} blend={blend} onAsk={onAsk} />
      </Workbench.Body>
    </>
  );
}

function ModelFacts({ info }: { info: ViewerModelInfo }) {
  return (
    <>
      <Workbench.Section title="Model">
        <Workbench.Row name="Triangles" reading={info.triangles.toLocaleString("en-US")} />
        <Workbench.Row name="Draw calls" reading={info.drawCalls} />
        <Workbench.Row name="Size" reading={`${info.size.join(" × ")} m (wide × tall × long)`} />
        <Workbench.Row
          name="Pivot"
          reading={`origin; bounds y ${info.bounds[0][1]} to ${info.bounds[1][1]} m`}
        />
        <Workbench.Row
          name="Skeleton"
          reading={info.bones === 0 ? "None" : countWords(info.bones, "bone", "bones")}
        />
        <Workbench.Row
          name="Clips"
          reading={
            info.clips.length === 0
              ? "None"
              : info.clips.map((clip) => `${clip.name} ${clip.duration.toFixed(1)} s`).join(", ")
          }
        />
      </Workbench.Section>
      <Workbench.Section title="Materials" detail={info.materials.length}>
        {info.materials.map((material, index) => (
          <Workbench.Row
            // oxlint-disable-next-line react/no-array-index-key -- two materials may share a name.
            key={`${index}:${material.name}`}
            mark={
              material.color === undefined ? undefined : (
                <span
                  className="size-3 rounded-sm ring-1 ring-border ring-inset"
                  style={{ backgroundColor: material.color }}
                />
              )
            }
            name={material.name}
            reading={material.type.replace(/Material$/, "")}
          />
        ))}
      </Workbench.Section>
      <Workbench.Section title="Textures" detail={info.textures.length}>
        {info.textures.length === 0 ? (
          <Text variant="caption" tone="muted" render={<p className="px-4" />}>
            None: its colours are its materials'.
          </Text>
        ) : (
          info.textures.map((texture, index) => (
            <Workbench.Row
              // oxlint-disable-next-line react/no-array-index-key -- two textures may share a name.
              key={`${index}:${texture.name}`}
              name={texture.name}
              reading={`${texture.slot} · ${texture.width} × ${texture.height}`}
            />
          ))
        )}
      </Workbench.Section>
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
  stageThing,
  values,
  handle,
}: {
  threadRef: ScopedThreadRef;
  asset: GameArtAsset;
  stageThing: GameThing | null;
  values: ReadonlyArray<GameThingValue>;
  handle: ModelViewerHandle | null;
}) {
  const saver = useTuneSaver(threadRef);
  if (stageThing === null || values.length === 0)
    return (
      <Workbench.Section title="Tint and scale">
        <Text variant="caption" tone="muted" render={<p className="px-4" />}>
          {stageThing === null
            ? "Play the game to tint or scale it: the game on the Stage holds its values."
            : "Its tint and scale show here when the game loads it through ASSETS; ask the agent to change it otherwise."}
        </Text>
      </Workbench.Section>
    );
  const id = asset.path;
  const tunes = [LOOK_TINT, LOOK_SCALE].map((base) => {
    const live = values.find((value) => value.key === base.key);
    return live === undefined ? base : { ...base, value: live.value };
  });
  const savedWords =
    saver.state.kind === "saving"
      ? "Keeping…"
      : saver.state.kind === "saved"
        ? "Kept as a build"
        : saver.state.kind === "waiting"
          ? "Kept once the agent's turn ends"
          : saver.state.kind === "failed"
            ? saver.state.text
            : null;
  return (
    <Workbench.Section title="Tint and scale" detail={savedWords ?? undefined}>
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

/** The ways to change an asset, by the route it came from; each lands as a build. */
function ChangeIt({
  threadRef,
  root,
  asset,
  blend,
  onAsk,
}: {
  threadRef: ScopedThreadRef;
  root: string;
  asset: GameArtAsset;
  blend: string | null;
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
  const config = useAtomValue(serverEnvironment.configValueAtom(threadRef.environmentId));
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const [openError, setOpenError] = useState<string | null>(null);
  const canOpen = config?.availableEditors.includes("file-manager") === true;
  const route = generation !== null ? "generated" : asset.route;
  return (
    <Workbench.Section title="Change it">
      {route === "generated" ? (
        <div className="flex flex-col gap-2 px-4 pt-1">
          <Text variant="caption" tone="muted">
            {generation === null
              ? "Generated; its generation record is not in this game."
              : `Generated by ${generation.provider}. Its prompt, to edit before generating again:`}
          </Text>
          <Textarea
            size="sm"
            value={prompt ?? generation?.prompt ?? ""}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            aria-label="Prompt"
            rows={3}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={(prompt ?? generation?.prompt ?? "").trim() === ""}
              onClick={() =>
                onAsk(
                  `Generate ${asset.path} again with game_art (my keys, the same kind${generation === null ? "" : ` and provider, ${generation.provider}`}) from this prompt, then put the new one in the game in its place:\n\n${(prompt ?? generation?.prompt ?? "").trim()}`,
                )
              }
            >
              Generate again
            </Button>
          </div>
        </div>
      ) : route === "library" ? (
        <ActionRow>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              onAsk(
                `Swap ${asset.path}${asset.pack === undefined ? "" : ` (library pack ${asset.pack})`} for another entry of the asset library that fits the game's look: show me the choices from game_assets op search first, then replace it where the game loads it.`,
              )
            }
          >
            Swap for another library entry
          </Button>
        </ActionRow>
      ) : route === "blender" ? (
        <ActionRow>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              onAsk(
                `Rework ${asset.path} in Blender with game_blender, review it, and export it again over the same file: `,
              )
            }
          >
            Rework in Blender
          </Button>
          {blend === null || !canOpen ? null : (
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                const result = await openInEditor({
                  environmentId: threadRef.environmentId,
                  input: { cwd: `${root}/${blend}`, editor: "file-manager" },
                });
                setOpenError(
                  result._tag === "Failure" ? String(squashAtomCommandFailure(result)) : null,
                );
              }}
            >
              Open in Blender
            </Button>
          )}
        </ActionRow>
      ) : (
        <ActionRow>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              onAsk(
                route === "code"
                  ? `Change ${asset.path}, which the game's code made: `
                  : `Record in ASSETS.md where ${asset.path} came from and its licence, or replace it with art whose source is known.`,
              )
            }
          >
            {route === "code" ? "Ask the agent to change it" : "Ask where it came from"}
          </Button>
        </ActionRow>
      )}
      {openError === null ? null : (
        <Text variant="caption" tone="destructive" render={<p role="alert" className="px-4" />}>
          {openError}
        </Text>
      )}
      <Text variant="caption" tone="muted" render={<p className="px-4 pt-2" />}>
        The agent's change lands as a build, so Undo takes it back.
      </Text>
    </Workbench.Section>
  );
}
