import { useEffect, useRef, useState, type ReactNode } from "react";
import type { GameBuild, ScopedThreadRef } from "@kurambit/contracts";

import { useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { cn } from "../../lib/utils";
import { gamePigment } from "./gameLibrary.logic";
import { GameKeyArt } from "./GameKeyArt";

/**
 * A build's picture: the frame its facts play kept, over the game's pigment.
 * The frame's signed URL is asked for only once the picture scrolls into view,
 * so a long strip costs one request per card the person actually sees.
 */
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
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (seen || node === null || build.still === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [seen, build.still]);
  const [pigment, ink] = gamePigment(gameName);
  return (
    <div
      ref={ref}
      className={cn("relative overflow-hidden", className)}
      style={{ background: `radial-gradient(120% 95% at 18% 8%, ${pigment}, ${ink})` }}
    >
      {seen && root !== null ? (
        <GameKeyArt environmentId={threadRef.environmentId} root={root} path={build.still} />
      ) : null}
      {children}
    </div>
  );
}
