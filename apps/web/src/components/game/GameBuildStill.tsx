import { useEffect, useRef, useState, type ReactNode } from "react";
import type { EnvironmentId, GameBuild, ScopedThreadRef } from "@kurambit/contracts";

import { useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { cn } from "../../lib/utils";
import { gamePigment } from "./gameLibrary.logic";
import { GameKeyArt } from "./GameKeyArt";
import { useBuildFrame } from "./gameStageBridge";

/**
 * A build's picture, for a game screen that knows its thread rather than its folder: the frame
 * the Stage showed while it played, else its measured play's frame, else its `title`
 * (the build's own name, so two builds without pictures never look alike).
 */
export function GameBuildStill({
  threadRef,
  gameName,
  build,
  title,
  className,
  mark,
  children,
}: {
  threadRef: ScopedThreadRef;
  gameName: string;
  build: Pick<GameBuild, "still"> & { readonly id?: string };
  /** What a picture-less build's title card says, in place of the game's name. */
  title?: string;
  className?: string;
  /** What stands in for a build with no picture: see GamePicture. */
  mark?: GamePictureMark;
  children?: ReactNode;
}) {
  const root = useIsGameThreadStatus(threadRef).data?.root ?? null;
  // The Stage's frame, once a build has one, stays its picture this session: a picture never
  // swaps under the person when a measured play's frame arrives later.
  const frame = useBuildFrame(build.id ?? null);
  if (frame !== null)
    return (
      <div
        className={cn("relative overflow-hidden bg-muted [container-type:inline-size]", className)}
      >
        <img src={frame} alt="" className="absolute inset-0 size-full object-cover" />
        {children}
      </div>
    );
  return (
    <GamePicture
      environmentId={threadRef.environmentId}
      root={root}
      path={build.still}
      gameName={gameName}
      title={title}
      className={className}
      mark={mark}
    >
      {children}
    </GamePicture>
  );
}

/**
 * What a picture that will not come shows on the game's pigment: its name as a title card
 * (covers and build slots), its initial (icons), a plain "No picture" (evidence, where a
 * name would pass for a frame), or nothing (a picture drawn over it anyway).
 */
export type GamePictureMark = "name" | "initial" | "absent" | "none";

/**
 * A game with no picture: its own pigment with its name as a title card, or its initial at icon
 * size, so it is never a blank box nor mistaken for a picture still loading.
 */
export function GameTitleMark({
  gameName,
  mark,
  title,
}: {
  gameName: string;
  mark: GamePictureMark;
  /** Said on the card in place of the game's name; the pigment stays the game's. */
  title?: string | undefined;
}) {
  const [pigment, ink] = gamePigment(gameName);
  const name = (title ?? gameName).trim();
  // Evidence with no frame is a neutral well, like a picture still coming: the game's pigment
  // would read as a picture of something.
  if (mark === "absent")
    return (
      <span aria-hidden="true" className="absolute inset-0 bg-muted">
        <span className="absolute top-1.5 left-2 text-caption text-muted-foreground">
          No picture
        </span>
      </span>
    );
  return (
    <span
      aria-hidden="true"
      className="absolute inset-0 grid place-items-center p-3 text-center"
      style={{ background: `radial-gradient(120% 95% at 18% 8%, ${pigment}, ${ink})` }}
    >
      {mark === "none" || name === "" ? null : mark === "name" ? (
        <span className="line-clamp-2 font-display text-xl/tight text-balance text-white/85 @3xs:text-2xl/tight @sm:text-3xl/tight">
          {name}
        </span>
      ) : (
        // An SVG letter scales with its icon, from the palette's 20px to the sidebar's 30px.
        <svg viewBox="0 0 10 10" className="absolute inset-0 size-full">
          <text x="5" y="7.4" textAnchor="middle" className="fill-white/80 font-display text-5xs">
            {name.charAt(0).toUpperCase()}
          </text>
        </svg>
      )}
    </span>
  );
}

/**
 * A game-relative picture (a build's frame) over the game's pigment. Its
 * signed URL is asked for only once the picture scrolls into view, so a long
 * strip or library costs one request per picture the person actually sees.
 * A neutral well means a picture is on its way; the game's pigment with
 * its name or initial means there is none.
 */
export function GamePicture({
  environmentId,
  root,
  path,
  gameName,
  title,
  className,
  mark = "initial",
  children,
}: {
  environmentId: EnvironmentId;
  root: string | null;
  path: string | null;
  gameName: string;
  title?: string | undefined;
  className?: string | undefined;
  mark?: GamePictureMark | undefined;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (seen || node === null || path === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [seen, path]);
  return (
    <div
      ref={ref}
      // A neutral well while a picture is on its way; the game's pigment only when there is none.
      className={cn("relative overflow-hidden bg-muted [container-type:inline-size]", className)}
    >
      {path === null ? (
        <GameTitleMark gameName={gameName} mark={mark} title={title} />
      ) : seen && root !== null ? (
        <GameKeyArt
          environmentId={environmentId}
          root={root}
          path={path}
          missing={<GameTitleMark gameName={gameName} mark={mark} title={title} />}
        />
      ) : null}
      {children}
    </div>
  );
}

/**
 * Now's picture: the frame the Stage last showed, taken from the game itself. Before it has
 * shown one (a title drawn in the page, not its canvas, gives none), the last build's picture,
 * dimmed, since the game has changed since it; with no build either, the game's name.
 */
export function GameNowPicture({
  still,
  gameName,
  fallback,
  threadRef,
  className,
  children,
}: {
  still: string | null;
  gameName: string;
  fallback: Pick<GameBuild, "still"> | null;
  threadRef: ScopedThreadRef | null;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <span
      className={cn(
        "relative block overflow-hidden bg-muted [container-type:inline-size]",
        className,
      )}
    >
      {still !== null ? (
        // The Stage's frame arriving over the stand-in fades in, never swaps in a frame.
        <img
          src={still}
          alt=""
          className="absolute inset-0 size-full object-cover transition-opacity motion-surface starting:opacity-0"
        />
      ) : fallback !== null && threadRef !== null ? (
        <GameBuildStill
          threadRef={threadRef}
          gameName={gameName}
          build={fallback}
          mark="name"
          className="absolute inset-0 opacity-55 saturate-50"
        />
      ) : (
        <GameTitleMark gameName={gameName} mark="name" />
      )}
      {children}
    </span>
  );
}
