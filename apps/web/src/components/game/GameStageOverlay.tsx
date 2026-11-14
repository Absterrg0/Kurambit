import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { GameStageRect, GameStageTrace, GameThing } from "@kurambit/contracts";

import { observeResize } from "../../lib/observeResize";
import { Text } from "../ui/text";
import { orbitStage, pointStage, useStageDevViews, useThreadStageBridge } from "./gameStageBridge";

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
  // Held because the Stage lost focus, the game is played again, not pointed at.
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
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const [area, setArea] = useState(0);
  // The free camera: a drag orbits, the wheel zooms, sent once per frame; a drag never selects.
  const flying = useStageDevViews(threadKey).freeCamera;
  const drag = useRef({ x: 0, y: 0, moved: 0, dx: 0, dy: 0, sent: true });
  useEffect(() => {
    if (layer === null) return;
    return observeResize(layer, () => setArea(layer.clientWidth * layer.clientHeight));
  }, [layer]);
  if (!frozen) return null;
  // A thing as big as the view (the level, the backdrop) needs no tag: it would only sit on
  // the game's own HUD, and the Tune tab already names it.
  const tagged = (rect: GameStageRect | undefined): rect is GameStageRect =>
    rect !== undefined && (area === 0 || rect.w * rect.h < area * FILLS_VIEW);
  const at = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  const onMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (flying && (event.buttons & 1) === 1) {
      const held = drag.current;
      held.dx += event.clientX - held.x;
      held.dy += event.clientY - held.y;
      held.moved += Math.abs(event.clientX - held.x) + Math.abs(event.clientY - held.y);
      held.x = event.clientX;
      held.y = event.clientY;
      if (!held.sent) return;
      held.sent = false;
      requestAnimationFrame(() => {
        orbitStage(held.dx * ORBIT_PER_PX, held.dy * ORBIT_PER_PX, 1);
        held.dx = 0;
        held.dy = 0;
        held.sent = true;
      });
      return;
    }
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
      ref={setLayer}
      className="absolute inset-0 z-20 overflow-hidden"
      data-game-stage-overlay=""
      onPointerMove={onMove}
      onPointerLeave={() => {
        pending.current = null;
      }}
      onPointerDown={(event) => {
        drag.current = { x: event.clientX, y: event.clientY, moved: 0, dx: 0, dy: 0, sent: true };
      }}
      onWheel={(event) => {
        if (flying) orbitStage(0, 0, event.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
      }}
      onClick={(event) => {
        if (!pointable || drag.current.moved > DRAG_PX) return;
        const point = at(event as unknown as ReactPointerEvent<HTMLDivElement>);
        pointStage(point.x, point.y, "select");
      }}
      // A double click goes into a group, as a design tool does: one clump of the grass.
      onDoubleClick={(event) => {
        if (!pointable) return;
        const point = at(event as unknown as ReactPointerEvent<HTMLDivElement>);
        pointStage(point.x, point.y, "select-inner");
      }}
    >
      {selected?.trace !== undefined ? <StageTrace trace={selected.trace} /> : null}
      {selected?.trace?.feel !== undefined ? (
        <FeelReadout name={selected.thing.name} feel={selected.trace.feel} />
      ) : null}
      {hovered !== null && tagged(hover?.rect) ? (
        <NameTag rect={hover.rect} thing={hovered} />
      ) : null}
      {selected !== null && tagged(selected.rect) ? (
        <NameTag rect={selected.rect} thing={selected.thing} selected />
      ) : null}
      {selected !== null &&
      selected.thing.instance === undefined &&
      (selected.thing.instances ?? 0) > 1 ? (
        <Text
          variant="caption"
          tone="inherit"
          render={
            <span className="pointer-events-none absolute right-3 bottom-3 rounded-md bg-black/60 px-2 py-1 text-stage-foreground/85" />
          }
        >
          All {selected.thing.instances} · double-click to pick one
        </Text>
      ) : null}
    </div>
  );
}

const EMPTY_THINGS: ReadonlyArray<GameThing> = [];
/** The free camera: radians a dragged pixel turns it, a wheel notch's zoom, a drag's least move. */
const ORBIT_PER_PX = 0.008;
const ZOOM_STEP = 1.12;
const DRAG_PX = 4;
/** The share of the view a thing's box covers when it is the view itself (a level, a sky). */
const FILLS_VIEW = 0.6;

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
      {thing.instance === undefined ? null : (
        <span className="tabular-nums">#{thing.instance.index + 1}</span>
      )}
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
      {/* Each jump's arc over the path, its apex marked with how high and how long. */}
      {/* Only the last jump is labelled: jumps side by side would print over each other. */}
      {(trace.feel?.jumps ?? []).map((jump, index, all) => (
        <g key={`j${jump.apex[0]},${jump.apex[1]}`}>
          <path
            d={smoothPath(jump.points, 0, jump.points.length - 1)}
            fill="none"
            className="stroke-stage-foreground"
            strokeOpacity={0.9}
            strokeWidth={2}
            strokeDasharray="4 3"
            strokeLinecap="round"
          />
          <circle cx={jump.apex[0]} cy={jump.apex[1]} r={3} className="fill-stage-foreground" />
          {index === all.length - 1 ? (
            <text
              x={jump.apex[0]}
              y={jump.apex[1] - 9}
              textAnchor="middle"
              className="fill-stage-foreground text-micro tabular-nums"
              stroke="var(--color-sumi)"
              strokeWidth={3}
              strokeOpacity={0.7}
              paintOrder="stroke"
            >
              {`${jump.height.toFixed(2)} m · ${jump.seconds.toFixed(2)} s`}
            </text>
          ) : null}
        </g>
      ))}
    </svg>
  );
}

const SPARK_W = 132;
const SPARK_H = 28;

/**
 * The selection's ground speed over the same seconds as its path, oldest at the left, and its
 * top speed and last jump in numbers: what a tuned speed or jump did, without a stopwatch.
 */
function FeelReadout({ name, feel }: { name: string; feel: NonNullable<GameStageTrace["feel"]> }) {
  const top = Math.max(feel.top, 0.1);
  const step = feel.speeds.length > 1 ? SPARK_W / (feel.speeds.length - 1) : 0;
  const line = feel.speeds
    .map(
      (speed, i) =>
        `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)} ${(SPARK_H - (Math.min(speed, top) / top) * SPARK_H).toFixed(1)}`,
    )
    .join(" ");
  const jump = feel.jumps.at(-1);
  return (
    <div className="pointer-events-none absolute right-3 bottom-3 flex flex-col gap-1 rounded-md bg-black/70 px-2.5 py-2 text-stage-foreground">
      <Text variant="caption" tone="inherit" numeric render={<span />}>
        {name} · top speed {feel.top.toFixed(1)} m/s
      </Text>
      <svg width={SPARK_W} height={SPARK_H} className="overflow-visible" aria-hidden>
        <path d={line} fill="none" className="stroke-stage-mark" strokeWidth={1.5} />
      </svg>
      {jump === undefined ? null : (
        <Text
          variant="caption"
          tone="inherit"
          numeric
          render={<span className="text-stage-muted" />}
        >
          Last jump {jump.height.toFixed(2)} m high, {jump.seconds.toFixed(2)} s in the air,{" "}
          {jump.distance.toFixed(1)} m long
        </Text>
      )}
    </div>
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
