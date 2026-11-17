import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import { orbitStage, pointStage, useStageDevViews, useThreadStageBridge } from "./gameStageBridge";

/**
 * Over the playing game while it is frozen: the layer that turns the pointer into
 * `studio-pointer` messages. The game draws the outlines, name tags and path itself
 * (stage-bridge.js), in the frame that draws the thing, so they never trail it.
 */
export function GameStageOverlay({ threadKey }: { threadKey: string }) {
  // Held because the Stage lost focus, the game is played again, not pointed at.
  const frozen = useThreadStageBridge(threadKey, (state) => state.frozen, false);
  const pointable = useThreadStageBridge(
    threadKey,
    (state) => state.status === "ready" && state.capabilities.includes("select"),
    false,
  );
  // One hover message per frame at most: the game raycasts on each.
  const pending = useRef<{ x: number; y: number } | null>(null);
  const scheduled = useRef(false);
  // The free camera: a drag orbits, the wheel zooms, sent once per frame; a drag never selects.
  const flying = useStageDevViews(threadKey).freeCamera;
  const drag = useRef({ x: 0, y: 0, moved: 0, dx: 0, dy: 0, sent: true });
  if (!frozen) return null;
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
  return (
    // Covers the game while it is frozen, so a click points instead of playing.
    <div
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
    />
  );
}

/** The free camera: radians a dragged pixel turns it, a wheel notch's zoom, a drag's least move. */
const ORBIT_PER_PX = 0.008;
const ZOOM_STEP = 1.12;
const DRAG_PX = 4;
