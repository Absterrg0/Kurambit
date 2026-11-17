import { useEffect, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  GAME_ART_THUMBNAIL_DIR,
  type GameThing,
  type GameThingFacts,
  type GameThingKind,
  type ScopedThreadRef,
} from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import {
  BoxIcon,
  FlameIcon,
  LayoutPanelTopIcon,
  MountainIcon,
  PawPrintIcon,
  PersonStandingIcon,
  ShapesIcon,
  SlidersHorizontalIcon,
  Volume2Icon,
  type LucideIcon,
} from "lucide-react";
import { create } from "zustand";

import { useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { cn } from "../../lib/utils";
import { gameEnvironment, stagePlayTarget } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { stageBuildId } from "./gameBuildTimeline.logic";
import { GameKeyArt } from "./GameKeyArt";
import { portraitStageThing } from "./gameStageBridge";

export const KIND_ICON: Record<GameThingKind, LucideIcon> = {
  character: PersonStandingIcon,
  creature: PawPrintIcon,
  prop: BoxIcon,
  level: MountainIcon,
  effect: FlameIcon,
  ui: LayoutPanelTopIcon,
  rule: SlidersHorizontalIcon,
  sound: Volume2Icon,
  other: ShapesIcon,
};

/** Kinds with no body to draw: their picture is their kind's glyph. */
const BODILESS: ReadonlySet<GameThingKind> = new Set(["rule", "sound", "ui"]);

/** The build on the Stage, which a code-made thing's picture is kept by; null for "Now". */
export function useStageBuild(threadRef: ScopedThreadRef) {
  const list = useEnvironmentQuery(
    gameEnvironment.builds({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  ).data;
  const asked = useAtomValue(stagePlayTarget(threadRef));
  return stageBuildId(list ?? null, asked?.build ?? null);
}

/** Pictures drawn this session by `${thread}\0${build}\0${thing}`: a PNG, or null when it has none. */
const useDrawn = create<Readonly<Record<string, string | null>>>()(() => ({}));
/** What each drawn thing is made of, by the same key, as the game counted it. */
const useFacts = create<Readonly<Record<string, GameThingFacts>>>()(() => ({}));

/** A thing's triangles, materials and size, once the game drew its picture this session. */
export const useThingFacts = (threadRef: ScopedThreadRef, build: string | null, id: string) =>
  useFacts((state) => state[`${scopedThreadKey(threadRef)}\0${build ?? "now"}\0${id}`] ?? null);

// One portrait at a time: each is two frames of the game drawn between two of its own.
let drawing: Promise<unknown> = Promise.resolve();
const PICTURE_PX = 256;
/** The least share of its square a picture must cover to be kept as one. */
const LEAST_COVER = 0.03;
const PICTURE_VIEW = { size: PICTURE_PX, yaw: 0.7, pitch: 0.55 } as const;

const sha256Hex = async (text: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/**
 * A named thing's picture as the game draws it alone (studio-portrait), kept by build and thing
 * beside Art's other thumbnails, so it is drawn once per build; its kind's glyph until then, and
 * for a thing with no body. Nothing here draws live.
 */
export function GameThingPicture({
  threadRef,
  thing,
  build,
  className,
}: {
  threadRef: ScopedThreadRef;
  thing: Pick<GameThing, "id" | "kind">;
  build: string | null;
  className?: string;
}) {
  const root = useIsGameThreadStatus(threadRef).data?.root ?? null;
  const key = `${scopedThreadKey(threadRef)}\0${build ?? "now"}\0${thing.id}`;
  const drawn = useDrawn((state) => state[key]);
  const [hash, setHash] = useState<{ readonly of: string; readonly hex: string } | null>(null);
  useEffect(() => {
    if (build === null) return;
    let live = true;
    void sha256Hex(`${build}\0${thing.id}\0studio`).then((hex) => {
      if (live) setHash({ of: key, hex });
    });
    return () => {
      live = false;
    };
  }, [build, thing.id, key]);
  const Icon = KIND_ICON[thing.kind];
  const glyph = (
    <span
      aria-hidden="true"
      className="absolute inset-0 flex items-center justify-center text-dim-foreground [&_svg]:size-[60%] [&_svg]:max-h-5 [&_svg]:max-w-5"
    >
      <Icon />
    </span>
  );
  const cached = hash !== null && hash.of === key ? hash.hex : null;
  let picture: ReactNode = glyph;
  if (typeof drawn === "string")
    picture = <img src={drawn} alt="" className="absolute inset-0 size-full object-contain" />;
  else if (drawn === undefined && !BODILESS.has(thing.kind) && root !== null)
    picture =
      build === null ? (
        <Draw threadRef={threadRef} id={thing.id} drawnKey={key} sha={null}>
          {glyph}
        </Draw>
      ) : cached === null ? (
        glyph
      ) : (
        <GameKeyArt
          environmentId={threadRef.environmentId}
          root={root}
          path={`${GAME_ART_THUMBNAIL_DIR}/${cached}.png`}
          className="object-contain"
          missing={
            <Draw threadRef={threadRef} id={thing.id} drawnKey={key} sha={cached}>
              {glyph}
            </Draw>
          }
        />
      );
  return (
    <span className={cn("relative shrink-0 overflow-hidden rounded-md bg-muted", className)}>
      {picture}
    </span>
  );
}

/** Asks the game for the picture no file holds yet, then keeps it; shows `children` meanwhile. */
function Draw({
  threadRef,
  id,
  drawnKey,
  sha,
  children,
}: {
  threadRef: ScopedThreadRef;
  id: string;
  drawnKey: string;
  sha: string | null;
  children: ReactNode;
}) {
  const keep = useAtomCommand(gameEnvironment.artThumbnail, { reportFailure: false });
  useEffect(() => {
    let live = true;
    drawing = drawing.then(async () => {
      if (!live || useDrawn.getState()[drawnKey] !== undefined) return;
      const portrait = await portraitStageThing(id, PICTURE_VIEW);
      // A game that cannot draw it now (no bridge yet, off the scene) is asked again next time.
      if (portrait === null) return;
      // A picture of almost nothing (specks, a thin line) reads as nothing: its kind's glyph does.
      if ((portrait.facts?.covers ?? 1) < LEAST_COVER) {
        useDrawn.setState({ [drawnKey]: null });
        if (portrait.facts !== undefined) useFacts.setState({ [drawnKey]: portrait.facts });
        return;
      }
      useDrawn.setState({ [drawnKey]: portrait.png });
      if (portrait.facts !== undefined) useFacts.setState({ [drawnKey]: portrait.facts });
      if (sha !== null)
        void keep({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, sha256: sha, png: portrait.png },
        });
    });
    return () => {
      live = false;
    };
  }, [drawnKey, id, sha, keep, threadRef.environmentId, threadRef.threadId]);
  return children;
}
