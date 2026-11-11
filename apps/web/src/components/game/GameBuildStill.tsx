import { useEffect, useRef, useState, type ReactNode } from "react";
import type { EnvironmentId, GameBuild, ScopedThreadRef } from "@kurambit/contracts";

import { useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { cn } from "../../lib/utils";
import { gamePigment } from "./gameLibrary.logic";
import { GameKeyArt } from "./GameKeyArt";

/** A build's picture, for a game screen that knows its thread rather than its folder. */
export function GameBuildStill({
  threadRef,
  gameName,
  build,
  className,
  children,
}: {
  threadRef: ScopedThreadRef;
  gameName: string;
  build: Pick<GameBuild, "still">;
  className?: string;
  children?: ReactNode;
}) {
  const root = useIsGameThreadStatus(threadRef).data?.root ?? null;
  return (
    <GamePicture
      environmentId={threadRef.environmentId}
      root={root}
      path={build.still}
      gameName={gameName}
      className={className}
    >
      {children}
    </GamePicture>
  );
}

/**
 * A game-relative picture (a build's frame) over the game's pigment. Its
 * signed URL is asked for only once the picture scrolls into view, so a long
 * strip or library costs one request per picture the person actually sees.
 */
export function GamePicture({
  environmentId,
  root,
  path,
  gameName,
  className,
  children,
}: {
  environmentId: EnvironmentId;
  root: string | null;
  path: string | null;
  gameName: string;
  className?: string | undefined;
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
  const [pigment, ink] = gamePigment(gameName);
  return (
    <div
      ref={ref}
      className={cn("relative overflow-hidden", className)}
      style={{ background: `radial-gradient(120% 95% at 18% 8%, ${pigment}, ${ink})` }}
    >
      {seen && root !== null ? (
        <GameKeyArt environmentId={environmentId} root={root} path={path} />
      ) : null}
      {children}
    </div>
  );
}
