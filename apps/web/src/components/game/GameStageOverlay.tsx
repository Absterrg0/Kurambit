import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { GameStageRect, GameStageTrace, GameThing } from "@kurambit/contracts";

import { pointStage, useThreadStageBridge } from "./gameStageBridge";

const KIND_WORD: Record<GameThing["kind"], string> = {
  character: "character",
  creature: "creature",
  prop: "prop",
  level: "level",
  effect: "effect",
  ui: "interface",
  rule: "rule",
  sound: "sound",
  other: "thing",
};

/**
 * Over the playing game: while it is frozen, the layer that turns the
 * pointer into `studio-pointer` messages, the name of what is under it, and
 * the selection's name and path. The game draws the outlines itself (its own
 * pixels); this draws only what the bridge reports, in the frame's own CSS
 * pixels, so nothing here repaints unless a message changed it.
 */
export function GameStageOverlay({ threadKey }: { threadKey: string }) {
  const frozen = useThreadStageBridge(threadKey, (state) => state.frozen, false);
  const pointable = useThreadStageBridge(
    threadKey,
    (state) => state.status === "ready" && state.capabilities.includes("select"),
    false,
  );
  const hover = useThreadStageBridge(threadKey, (state) => state.hover, null);
  const selected = useThreadStageBridge(threadKey, (state) => state.selected, null);
  const things = useThreadStageBridge(threadKey, (state) => state.things, EMPTY_THINGS);
  // One hover message per frame at most: the game raycasts on each.
  const pending = useRef<{ x: number; y: number } | null>(null);
  const scheduled = useRef(false);
  if (!frozen) return null;
  const at = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  const onMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointable) return;
    pending.current = at(event);
    if (scheduled.current) return;
    scheduled.current = true;
    requestAnimationFrame(() => {
      scheduled.current = false;
      const point = pending.current;
      if (point !== null) pointStage(point.x, point.y, "hover");
    });
  };
  const hovered =
    hover === null || hover.rect === undefined || hover.id === selected?.thing.id
      ? null
      : (things.find((thing) => thing.id === hover.id) ?? null);
  return (
    // Covers the game while it is frozen, so a click points instead of playing.
    <div
      className="absolute inset-0 z-20 overflow-hidden"
      data-game-stage-overlay=""
      onPointerMove={onMove}
      onPointerLeave={() => {
        pending.current = null;
      }}
      onClick={(event) => {
        if (!pointable) return;
        const point = at(event as unknown as ReactPointerEvent<HTMLDivElement>);
        pointStage(point.x, point.y, "select");
      }}
    >
      {selected?.trace !== undefined ? <StageTrace trace={selected.trace} /> : null}
      {hovered !== null && hover?.rect !== undefined ? (
        <NameTag rect={hover.rect} thing={hovered} />
      ) : null}
      {selected?.rect !== undefined ? (
        <NameTag rect={selected.rect} thing={selected.thing} selected />
      ) : null}
    </div>
  );
}

const EMPTY_THINGS: ReadonlyArray<GameThing> = [];

function NameTag({
  rect,
  thing,
  selected = false,
}: {
  rect: GameStageRect;
  thing: GameThing;
  selected?: boolean;
}) {
  return (
    <span
      className={
        selected
          ? "pointer-events-none absolute flex -translate-y-full items-baseline gap-1.5 rounded-md bg-stage-mark px-1.5 py-0.5 text-xs text-white shadow-md"
          : "pointer-events-none absolute flex -translate-y-full items-baseline gap-1.5 rounded-md bg-black/85 px-1.5 py-0.5 text-xs text-stage-foreground shadow-md"
      }
      style={{ left: Math.max(0, rect.x), top: Math.max(22, rect.y - 4) }}
    >
      {thing.name}
      <span className={selected ? "text-2xs text-white/75" : "text-2xs text-stage-muted"}>
        {KIND_WORD[thing.kind]}
      </span>
    </span>
  );
}

/** How many segments the path is cut into, so its older end can be thinner and fainter. */
const TRACE_SEGMENTS = 24;

/**
 * The selection's last seconds as one smooth line: older is thinner and
 * fainter, so time reads without a legend. A dark line under it keeps it
 * legible on a light floor.
 */
function StageTrace({ trace }: { trace: GameStageTrace }) {
  const points = trace.points;
  if (points.length < 2) return null;
  const per = Math.max(1, Math.ceil((points.length - 1) / TRACE_SEGMENTS));
  const segments: Array<{ d: string; k: number }> = [];
  for (let start = 0; start < points.length - 1; start += per) {
    const end = Math.min(points.length - 1, start + per);
    segments.push({
      d: smoothPath(
        points.slice(Math.max(0, start - 1), end + 2),
        start === 0 ? 0 : 1,
        end - start,
      ),
      k: end / (points.length - 1),
    });
  }
  const [x0, y0] = points[0]!;
  return (
    <svg className="pointer-events-none absolute inset-0 size-full overflow-visible" aria-hidden>
      {segments.map((segment) => (
        <path
          key={`u${segment.d}`}
          d={segment.d}
          fill="none"
          stroke="var(--color-sumi)"
          strokeOpacity={0.12 + 0.2 * segment.k}
          strokeWidth={2.6 + 3.2 * segment.k}
          strokeLinecap="round"
        />
      ))}
      {segments.map((segment) => (
        <path
          key={`m${segment.d}`}
          d={segment.d}
          fill="none"
          className="stroke-stage-mark"
          strokeOpacity={0.3 + 0.7 * segment.k}
          strokeWidth={0.8 + 2.2 * segment.k}
          strokeLinecap="round"
        />
      ))}
      <circle cx={x0} cy={y0} r={3.5} className="fill-stage-mark" fillOpacity={0.55} />
    </svg>
  );
}

/**
 * A Catmull-Rom curve through `count` spans of `points`, starting at span
 * `from` (the points before and after give the curve its tangents).
 */
const smoothPath = (
  points: ReadonlyArray<readonly [number, number]>,
  from: number,
  count: number,
): string => {
  const at = (i: number) => points[Math.max(0, Math.min(points.length - 1, i))]!;
  let d = "";
  for (let i = from; i < from + count && i + 1 < points.length; i += 1) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    if (d === "") d = `M${p1[0]} ${p1[1]}`;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${p2[0]} ${p2[1]}`;
  }
  return d;
};
