import { LegendList } from "@legendapp/list/react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@kurambit/client-runtime/state/runtime";
import type { EnvironmentId, GameArtAsset, GameLibraryItem } from "@kurambit/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ImageIcon,
  MessageSquarePlusIcon,
  PackageIcon,
  PlusIcon,
  ShapesIcon,
  PaletteIcon,
  SquarePenIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { useAssetUrlState } from "../../assets/assetUrls";
import { isElectron } from "../../env";
import { openGameTool } from "../../gameArrivalStore";
import { useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { cn, randomUUID } from "../../lib/utils";
import { observeResize } from "../../lib/observeResize";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects, useThreadShells } from "../../state/entities";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  AudioViewer,
  FontViewer,
  TextureViewer,
  useFontFamily,
  useSoundPeaks,
} from "../game/GameArtViewers";
import { bytesWords, countWords } from "../game/gameArt.logic";
import { attachAssetToComposer } from "../game/gameComposerContext";
import { useNewGame } from "../game/gameEntryStore";
import { useGameLibrary } from "../game/useGameLibrary";
import { buildGameTree } from "../sidebar/gameTree.logic";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SidebarInset } from "../ui/sidebar";
import { Text } from "../ui/text";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useLastGameChat } from "./lastGameChat";
import {
  familyWords,
  libraryTiles,
  usedInWords,
  type LibraryKindFilter,
  type LibrarySourceFilter,
} from "./library.logic";

const KINDS: ReadonlyArray<{ readonly value: LibraryKindFilter; readonly label: string }> = [
  { value: "all", label: "All" },
  { value: "model", label: "Models" },
  { value: "texture", label: "Textures" },
  { value: "audio", label: "Sounds" },
  { value: "font", label: "Fonts" },
  { value: "look", label: "Looks" },
];
const SOURCES: ReadonlyArray<{ readonly value: LibrarySourceFilter; readonly label: string }> = [
  { value: "yours", label: "Yours" },
  { value: "packs", label: "Packs" },
];
const NO_ITEMS: ReadonlyArray<GameLibraryItem> = [];
const TILE_MIN = 148;
const GAP = 16;
const EDGE = 24;
/** The name and the line under it, below the square picture. */
const CAPTION_H = 40;

/** A game's name as its project title says it, else as game.json does. */
function useGameNames() {
  const projects = useProjects();
  const byId = new Map(projects.map((project) => [project.id as string, project.title] as const));
  return (projectId: string, fallback: string) => byId.get(projectId) ?? fallback;
}

/** An item's file as Art's viewers take it: they read it by folder and path. */
const viewerAsset = (item: GameLibraryItem): GameArtAsset | null => {
  if (item.file === undefined) return null;
  const kind = item.kind;
  if (kind !== "model" && kind !== "texture" && kind !== "audio" && kind !== "font") return null;
  const sha = item.id.startsWith("asset:") ? item.id.slice(6) : "0".repeat(64);
  return {
    path: item.file.path,
    url: item.file.path,
    kind,
    bytes: item.bytes ?? 0,
    sha256: sha,
    route: "unrecorded",
  };
};

/**
 * The Library: every model, texture, sound and font in the person's games, models they saved,
 * the open library's packs and every game's look, in one grid. Nothing is read until it opens.
 */
export function LibraryPage() {
  const environmentId = usePrimaryEnvironmentId();
  useEffect(() => openGameTool("library"), []);
  const read = useEnvironmentQuery(
    environmentId === null ? null : gameEnvironment.libraryList({ environmentId, input: {} }),
  );
  const items = read.data?.items ?? NO_ITEMS;
  const asked = useSearch({ from: "/_chat/library", select: (search) => search.item ?? null });
  const [kind, setKind] = useState<LibraryKindFilter>("all");
  const [source, setSource] = useState<LibrarySourceFilter>(
    asked?.startsWith("pack:") === true ? "packs" : "yours",
  );
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(asked);
  // Search opening the page on another item while it is open.
  const [lastAsked, setLastAsked] = useState(asked);
  if (asked !== lastAsked) {
    setLastAsked(asked);
    if (asked !== null) {
      setSelectedId(asked);
      setSource(asked.startsWith("pack:") ? "packs" : "yours");
      setKind("all");
      setSearch("");
    }
  }
  const tiles = libraryTiles(items, { kind, source }, search);
  // Nothing under these filters: the one step that shows something, with its count.
  const allKinds = libraryTiles(items, { kind: "all", source }, "");
  const packs = libraryTiles(items, { kind: "all", source: "packs" }, "");
  const empty =
    search !== "" ? (
      <Button size="sm" variant="outline" onClick={() => setSearch("")}>
        {`Clear “${search}”`}
      </Button>
    ) : kind !== "all" && allKinds.length > 0 ? (
      <Button size="sm" variant="outline" onClick={() => setKind("all")}>
        {`Show all ${allKinds.length}`}
      </Button>
    ) : source === "yours" && packs.length > 0 ? (
      <Button size="sm" variant="outline" onClick={() => setSource("packs")}>
        {`Browse ${packs.length} ${packs.length === 1 ? "pack" : "packs"}`}
      </Button>
    ) : null;
  // The detail is the open tile's: a filter that hides it closes it.
  const selected = tiles.find((item) => item.id === selectedId) ?? null;
  const loading = read.data === null || read.data === undefined;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron}>
          <Text variant="label" tone="strong" render={<h1 className="shrink-0" />}>
            Library
          </Text>
          <ToggleGroup
            aria-label="Kind"
            variant="segmented"
            value={[kind]}
            onValueChange={(next) => {
              const picked = KINDS.find((each) => each.value === next[0]);
              if (picked !== undefined) setKind(picked.value);
            }}
          >
            {KINDS.map((each) => (
              <Toggle key={each.value} value={each.value}>
                {each.label}
              </Toggle>
            ))}
          </ToggleGroup>
          <span className="flex-1" />
          <ToggleGroup
            aria-label="Source"
            variant="segmented"
            value={[source]}
            onValueChange={(next) => {
              const picked = SOURCES.find((each) => each.value === next[0]);
              if (picked !== undefined) setSource(picked.value);
            }}
          >
            {SOURCES.map((each) => (
              <Toggle key={each.value} value={each.value}>
                {each.label}
              </Toggle>
            ))}
          </ToggleGroup>
          <Input
            size="sm"
            type="search"
            value={search}
            placeholder="Search"
            aria-label="Search the Library"
            onChange={(event) => setSearch(event.currentTarget.value)}
            className="w-56 shrink-0"
          />
        </WorkspacePageHeader>
        <div className="flex min-h-0 flex-1 border-t border-border">
          {environmentId === null ? null : (
            <LibraryGrid
              environmentId={environmentId}
              tiles={tiles}
              loading={loading}
              listKey={`${kind}:${source}:${search}`}
              empty={empty}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}
          {selected === null || environmentId === null ? null : (
            <LibraryDetail
              key={selected.id}
              environmentId={environmentId}
              item={selected}
              onClose={() => setSelectedId(null)}
              onRemoved={() => {
                setSelectedId(null);
                read.refresh();
              }}
            />
          )}
        </div>
      </div>
    </SidebarInset>
  );
}

// ─── The grid ────────────────────────────────────────────────────────────────────

function LibraryGrid({
  environmentId,
  tiles,
  loading,
  listKey,
  empty,
  selectedId,
  onSelect,
}: {
  environmentId: EnvironmentId;
  tiles: ReadonlyArray<GameLibraryItem>;
  loading: boolean;
  /** A new filter is a new list, from its top. */
  listKey: string;
  /** What shows with no tiles: the one step that shows some. */
  empty: ReactNode;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [width, setWidth] = useState(0);
  const measure = (element: HTMLDivElement | null) => {
    if (element === null) return;
    setWidth(element.clientWidth);
    return observeResize(element, () => setWidth(element.clientWidth));
  };
  const columns = Math.max(2, Math.floor((width - 2 * EDGE + GAP) / (TILE_MIN + GAP)));
  const tileWidth = (width - 2 * EDGE - GAP * (columns - 1)) / columns;
  const rows: GameLibraryItem[][] = [];
  for (let index = 0; index < tiles.length; index += columns)
    rows.push(tiles.slice(index, index + columns));
  return (
    <div ref={measure} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {width === 0 || loading ? null : tiles.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">{empty}</div>
      ) : (
        <LegendList<GameLibraryItem[]>
          key={listKey}
          data={rows}
          keyExtractor={(row) => row[0]!.id}
          estimatedItemSize={tileWidth + CAPTION_H + GAP}
          recycleItems={false}
          extraData={`${selectedId}:${columns}`}
          style={{ flex: 1, minHeight: 0 }}
          contentContainerStyle={{ paddingTop: EDGE, paddingBottom: EDGE }}
          renderItem={({ item: row }) => (
            <div
              className="grid px-6"
              style={{
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                columnGap: GAP,
                paddingBottom: GAP,
              }}
            >
              {row.map((item) => (
                <LibraryTile
                  key={item.id}
                  environmentId={environmentId}
                  item={item}
                  selected={item.id === selectedId}
                  onSelect={() => onSelect(item.id)}
                />
              ))}
            </div>
          )}
        />
      )}
    </div>
  );
}

/** One tile: the square picture on the neutral surface, its name, and where it is from. */
function LibraryTile({
  environmentId,
  item,
  selected,
  onSelect,
}: {
  environmentId: EnvironmentId;
  item: GameLibraryItem;
  selected: boolean;
  onSelect: () => void;
}) {
  const nameOf = useGameNames();
  const from =
    item.source === "saved"
      ? `Saved from ${item.from ?? "a game"}`
      : item.source === "pack"
        ? (item.pack?.author ?? "")
        : item.source === "look"
          ? item.look?.family === undefined
            ? "Look"
            : familyWords(item.look.family)
          : usedInWords(item, nameOf);
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className="group/tile flex min-w-0 cursor-pointer flex-col gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <span
        className={cn(
          "relative block aspect-square w-full overflow-hidden rounded-md bg-muted ring-border ring-inset group-hover/tile:ring-1",
          selected && "ring-2 ring-primary group-hover/tile:ring-2",
        )}
      >
        <TilePicture environmentId={environmentId} item={item} />
      </span>
      <span className="flex min-w-0 flex-col">
        <Text variant="meta" tone="default" truncate>
          {item.name}
        </Text>
        <Text variant="caption" tone="muted" truncate>
          {from}
        </Text>
      </span>
    </button>
  );
}

const Glyph = ({ children }: { children: ReactNode }) => (
  <span
    aria-hidden="true"
    className="absolute inset-0 flex items-center justify-center text-dim-foreground [&_svg]:size-6"
  >
    {children}
  </span>
);

function TilePicture({
  environmentId,
  item,
}: {
  environmentId: EnvironmentId;
  item: GameLibraryItem;
}) {
  if (item.kind === "look" && item.look !== undefined)
    return <Palette colours={item.look.palette} />;
  if (item.kind === "audio") return <WaveTile environmentId={environmentId} item={item} />;
  if (item.kind === "font") return <FontTile environmentId={environmentId} item={item} />;
  const picture = item.kind === "texture" ? item.file : item.picture;
  const glyph =
    item.kind === "pack" ? (
      <PackageIcon />
    ) : item.kind === "texture" ? (
      <ImageIcon />
    ) : (
      <ShapesIcon />
    );
  if (picture === undefined) return <Glyph>{glyph}</Glyph>;
  return (
    <FileImage
      environmentId={environmentId}
      file={picture}
      pixelated={item.kind === "texture"}
      cover={item.kind === "pack"}
      missing={<Glyph>{glyph}</Glyph>}
    />
  );
}

function FileImage({
  environmentId,
  file,
  pixelated = false,
  cover = false,
  missing,
}: {
  environmentId: EnvironmentId;
  file: NonNullable<GameLibraryItem["file"]>;
  pixelated?: boolean;
  cover?: boolean;
  missing: ReactNode;
}) {
  const state = useAssetUrlState(environmentId, {
    _tag: "draft-workspace-file",
    cwd: file.root,
    path: file.path,
  });
  if (state._tag !== "Success") return missing;
  return (
    <img
      src={state.url}
      alt=""
      decoding="async"
      className={cn(
        "absolute inset-0 size-full",
        cover ? "object-cover" : "object-contain",
        pixelated && "[image-rendering:pixelated]",
      )}
    />
  );
}

/** A look's palette as even bands. */
function Palette({ colours }: { colours: ReadonlyArray<string> }) {
  if (colours.length === 0) return <Glyph>{<PaletteIcon />}</Glyph>;
  return (
    <span className="absolute inset-0 flex">
      {colours.slice(0, 8).map((hex, index) => (
        <span
          // oxlint-disable-next-line react/no-array-index-key -- a palette may repeat a colour.
          key={`${index}:${hex}`}
          className="h-full flex-1"
          style={{ background: hex }}
        />
      ))}
    </span>
  );
}

const WAVE_BARS = 28;

/** A sound's tile: its waveform, drawn once from its peaks (Art's own decoder). */
function WaveTile({
  environmentId,
  item,
}: {
  environmentId: EnvironmentId;
  item: GameLibraryItem;
}) {
  const state = useAssetUrlState(
    environmentId,
    item.file === undefined
      ? null
      : { _tag: "draft-workspace-file", cwd: item.file.root, path: item.file.path },
  );
  const wave = useSoundPeaks(state._tag === "Success" ? state.url : null, item.id);
  const peaks = wave === null || wave === "failed" ? null : wave.peaks;
  if (peaks === null) return <Glyph>{<WaveGlyph />}</Glyph>;
  const step = peaks.length / WAVE_BARS;
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${WAVE_BARS * 4} 40`}
      preserveAspectRatio="none"
      className="absolute inset-x-4 top-1/2 h-1/3 w-[calc(100%-2rem)] -translate-y-1/2 text-muted-foreground"
    >
      {Array.from({ length: WAVE_BARS }, (_, index) => {
        const slice = peaks.slice(Math.floor(index * step), Math.floor((index + 1) * step));
        const peak = Math.max(0.04, ...slice);
        const height = Math.max(2, peak * 40);
        return (
          <rect
            key={index}
            x={index * 4 + 0.5}
            y={(40 - height) / 2}
            width={2.5}
            height={height}
            rx={1}
            fill="currentColor"
          />
        );
      })}
    </svg>
  );
}

const WaveGlyph = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
  >
    <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />
  </svg>
);

/** A font's tile: "Aa" set in it, loaded only while the tile is on screen. */
function FontTile({
  environmentId,
  item,
}: {
  environmentId: EnvironmentId;
  item: GameLibraryItem;
}) {
  const asset = viewerAsset(item);
  const family = useFontFamily(environmentId, item.file?.root ?? "", asset ?? FALLBACK_FONT);
  return (
    <span className="absolute inset-0 flex items-center justify-center">
      {family === null || family === "failed" ? (
        <span className="text-4xl text-dim-foreground">Aa</span>
      ) : (
        <span className="text-5xl text-foreground" style={{ fontFamily: family }}>
          Aa
        </span>
      )}
    </span>
  );
}
const FALLBACK_FONT: GameArtAsset = {
  path: "-",
  url: "-",
  kind: "font",
  bytes: 0,
  sha256: "0".repeat(64),
  route: "unrecorded",
};

// ─── The detail ──────────────────────────────────────────────────────────────────

function LibraryDetail({
  environmentId,
  item,
  onClose,
  onRemoved,
}: {
  environmentId: EnvironmentId;
  item: GameLibraryItem;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const nameOf = useGameNames();
  const navigate = useNavigate();
  const newGame = useNewGame();
  const lastChat = useLastGameChat((state) => state.chat);
  const lastProject = useLastGameChat((state) => state.projectId);
  const library = useGameLibrary();
  const threads = useThreadShells();
  const games = buildGameTree({ games: library.games, threads, sort: "recent" }).live.flatMap(
    (node) => (node.main === null ? [] : [{ node, main: node.main }]),
  );
  const ordered = [
    ...games.filter((each) => each.node.game.projectId === lastProject),
    ...games.filter((each) => each.node.game.projectId !== lastProject),
  ];
  const add = useAtomCommand(gameEnvironment.libraryAdd, { reportFailure: false });
  const remove = useAtomCommand(gameEnvironment.libraryRemove, { reportFailure: false });
  const openArtAsset = useGameWorkspaceStore((state) => state.openArtAsset);
  const [busy, setBusy] = useState(false);
  const asset = viewerAsset(item);
  const kindWord =
    item.kind === "audio"
      ? "Sound"
      : item.kind === "pack"
        ? "Pack"
        : `${item.kind.charAt(0).toUpperCase()}${item.kind.slice(1)}`;

  const addTo = async (target: (typeof ordered)[number]) => {
    setBusy(true);
    const result = await add({
      environmentId,
      input: { threadId: target.main.id, id: item.id, commandId: randomUUID() },
    });
    setBusy(false);
    const gameName = nameOf(target.node.game.projectId, target.node.game.name);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: `Could not add it to ${gameName}`,
        description: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const landed = result.value.path;
    toastManager.add({
      type: "success",
      title: `Added to ${gameName}`,
      description: landed,
      actionProps: {
        children: "Show it",
        onClick: () => {
          if (item.kind !== "look") openArtAsset(landed);
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: target.main.id },
          });
        },
      },
    });
  };
  const ask = async () => {
    if (lastChat === null) return;
    const where =
      item.source === "saved"
        ? `saved from ${item.from ?? "a game"} (${item.part ?? item.name})`
        : item.source === "pack"
          ? `the ${item.name} pack by ${item.pack?.author ?? "its author"}`
          : `in ${usedInWords(item, nameOf)}`;
    await attachAssetToComposer(
      lastChat,
      {
        key: `library-${item.id}`,
        label: item.name,
        context: [
          `From the Library: ${kindWord.toLowerCase()} "${item.name}", ${where}.`,
          item.credit === undefined ? null : `Licence: ${item.credit}.`,
          item.source === "pack"
            ? `game_assets op search with pack "${item.id.slice(5)}" lists its files.`
            : `game_assets op mine with add "${item.id}" adds it to this game.`,
        ]
          .filter((line) => line !== null)
          .join(" "),
      },
      null,
    );
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: lastChat.threadId },
    });
  };
  const used = usedInWords(item, nameOf);
  return (
    <aside
      aria-label={item.name}
      className="flex w-90 shrink-0 flex-col overflow-y-auto border-s border-border"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 ps-4 pe-2">
        <Text variant="label" tone="strong" truncate render={<h2 className="min-w-0 flex-1" />}>
          {item.name}
        </Text>
        <Text variant="caption" tone="muted">
          {kindWord}
        </Text>
        <Tooltip>
          <TooltipTrigger
            render={<Button size="icon-sm" variant="ghost" aria-label="Close" onClick={onClose} />}
          >
            <XIcon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Close</TooltipPopup>
        </Tooltip>
      </div>
      {item.kind === "texture" && asset !== null && item.file !== undefined ? (
        <TextureViewer environmentId={environmentId} root={item.file.root} asset={asset} />
      ) : item.kind === "audio" && asset !== null && item.file !== undefined ? (
        <AudioViewer environmentId={environmentId} root={item.file.root} asset={asset} />
      ) : item.kind === "font" && asset !== null && item.file !== undefined ? (
        <FontViewer environmentId={environmentId} root={item.file.root} asset={asset} />
      ) : (
        <div className="relative aspect-square w-full shrink-0 bg-stage-well">
          <TilePicture environmentId={environmentId} item={item} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 px-4 py-4">
        {item.source === "pack" || ordered.length === 0 ? null : (
          <Menu>
            <MenuTrigger render={<Button size="sm" variant="secondary" disabled={busy} />}>
              <PlusIcon aria-hidden="true" />
              {item.kind === "look" ? "Use this look" : "Add to game"}
              <ChevronDownIcon aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup align="start" side="bottom">
              {item.kind === "look" ? (
                <>
                  <MenuItem
                    onClick={() =>
                      newGame({
                        brief: `A new game in the look of ${item.name}${item.look?.family === undefined ? "" : ` (${familyWords(item.look.family)})`}, palette ${(item.look?.palette ?? []).join(" ")}: `,
                      })
                    }
                  >
                    <SquarePenIcon aria-hidden="true" />A new game
                  </MenuItem>
                  <MenuSeparator />
                </>
              ) : null}
              <MenuGroup>
                <MenuGroupLabel>{item.kind === "look" ? "Use in" : "Add to"}</MenuGroupLabel>
                {ordered.map((target) => (
                  <MenuItem key={target.node.key} onClick={() => void addTo(target)}>
                    {nameOf(target.node.game.projectId, target.node.game.name)}
                  </MenuItem>
                ))}
              </MenuGroup>
            </MenuPopup>
          </Menu>
        )}
        {lastChat === null ? null : (
          <Button size="sm" variant="ghost" onClick={() => void ask()}>
            <MessageSquarePlusIcon aria-hidden="true" />
            Ask about this
          </Button>
        )}
      </div>
      <dl className="flex flex-col gap-2 px-4 pb-4">
        {used === "" ? null : <Fact name="Used in" reading={used} />}
        {item.source === "saved" ? (
          <Fact
            name="Saved from"
            reading={`${item.from ?? "a game"} · ${item.part ?? item.name}`}
          />
        ) : null}
        {item.credit === undefined ? null : <Fact name="Licence" reading={item.credit} />}
        {item.pack === undefined ? null : (
          <>
            <Fact name="By" reading={item.pack.author} />
            <Fact name="On this machine" reading={item.pack.installed ? "Yes" : "Not yet"} />
            <Text variant="body" tone="muted" render={<dd className="pt-1" />}>
              {item.pack.description}
            </Text>
          </>
        )}
        {item.look === undefined ? null : (
          <>
            {item.look.family === undefined ? null : (
              <Fact name="Family" reading={familyWords(item.look.family)} />
            )}
            <Fact name="Mode" reading={item.look.mode === "pixel" ? "Pixel art" : "Smooth"} />
          </>
        )}
        {item.triangles === undefined ? null : (
          <Fact name="Triangles" reading={countWords(item.triangles, "triangle", "triangles")} />
        )}
        {item.bytes === undefined ? null : <Fact name="Size" reading={bytesWords(item.bytes)} />}
      </dl>
      {item.source === "saved" ? (
        <div className="mt-auto px-4 pb-4">
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void remove({ environmentId, input: { id: item.id } }).then((result) => {
                if (result._tag === "Success") onRemoved();
              })
            }
          >
            <Trash2Icon aria-hidden="true" />
            Remove from Library
          </Button>
        </div>
      ) : null}
    </aside>
  );
}

function Fact({ name, reading }: { name: string; reading: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-3">
      <Text variant="meta" tone="muted" render={<dt className="w-24 shrink-0" />}>
        {name}
      </Text>
      <Text variant="body" tone="default" render={<dd className="min-w-0 flex-1" />}>
        {reading}
      </Text>
    </div>
  );
}
