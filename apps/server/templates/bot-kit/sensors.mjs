// Bot kit: sensors. Read helpers over one raw tick observation from the
// runner (the `last` argument of observe(api, last)).
//
// Raw shape: {t, tick, probe: {gameState, player: {x,y,z}|null, hudText},
// body: {present, dim ("2d"/"3d"), onGround, touching, vx, vy, vz?},
// visible: [{kind,label} UI controls, {label,dist,bearing,dy,inView} 3D
// landmarks], room: {forward,back,left,right, drop_forward,...}|null (3D
// only; world axes, forward = -Z), sweep: {overlaps}|null every 5th tick,
// errors: [{message}]}.
//
// Adapted from Aura's autopilot kit/control.py + nav.py (Apache-2.0,
// ramenvr/autopilot): the ideas (stuck handling, drop sensing, per-tick
// control) are theirs; this code is ours, shaped to our runner protocol
// (per-tick step functions, not generators: run(api, obs) must answer at
// once, every tick).

export function posOf(raw) {
  const p = raw?.probe?.player ?? null;
  if (p === null || typeof p !== "object") return null;
  if (typeof p.x !== "number" || typeof p.y !== "number") return null;
  return { x: p.x, y: p.y, z: typeof p.z === "number" ? p.z : 0 };
}

export function stateOf(raw) {
  const gs = raw?.probe?.gameState ?? {};
  return typeof gs.state === "string" ? gs.state : "unknown";
}

export function factsOf(raw) {
  return raw?.probe?.gameState ?? {};
}

export function hudOf(raw) {
  return typeof raw?.probe?.hudText === "string" ? raw.probe.hudText : "";
}

export function hudHas(raw, re) {
  return re.test(hudOf(raw));
}

export function bodyOf(raw) {
  return raw?.body ?? { present: false };
}

export function speed2d(raw) {
  const b = bodyOf(raw);
  return Math.hypot(Number(b.vx) || 0, Number(b.vz ?? b.vy) || 0);
}

export function dimOf(raw) {
  return bodyOf(raw).dim === "2d" ? "2d" : "3d";
}

// Clearance in metres along a world XZ direction, from the room rays
// (forward=-Z, back=+Z, left=-X, right=+X). Null when unknown (2D games).
export function clearance(raw, dx, dz) {
  const room = raw?.room ?? null;
  if (room === null || typeof room !== "object") return null;
  const n = Math.hypot(dx, dz);
  if (n < 1e-6) return null;
  const ux = dx / n;
  const uz = dz / n;
  const w =
    Math.max(0, -uz) * Number(room.forward ?? 6) +
    Math.max(0, uz) * Number(room.back ?? 6) +
    Math.max(0, -ux) * Number(room.left ?? 6) +
    Math.max(0, ux) * Number(room.right ?? 6);
  const wsum = Math.abs(ux) + Math.abs(uz);
  return wsum < 1e-6 ? null : w / wsum;
}

// Floor distance 1.2m ahead in an XZ direction (metres, DROP_DIST when no
// floor). Null when unknown (2D games). Deeper than ~2m means a drop ahead.
export function floorAhead(raw, dx, dz) {
  const room = raw?.room ?? null;
  if (room === null || typeof room !== "object") return null;
  const n = Math.hypot(dx, dz);
  if (n < 1e-6) return null;
  const ux = dx / n;
  const uz = dz / n;
  const pick = (key, weight) => (Number(room[key] ?? 4) || 0) * weight;
  const wsum = Math.abs(ux) + Math.abs(uz);
  if (wsum < 1e-6) return null;
  return (
    (pick("drop_forward", Math.max(0, -uz)) +
      pick("drop_back", Math.max(0, uz)) +
      pick("drop_left", Math.max(0, -ux)) +
      pick("drop_right", Math.max(0, ux))) /
    wsum
  );
}

export function dropAhead(raw, dx, dz, deeperThan = 2.0) {
  const f = floorAhead(raw, dx, dz);
  return f !== null && f >= deeperThan;
}

// Nearest 3D landmark whose label matches, or null.
export function nearestVisible(raw, match) {
  const vis = Array.isArray(raw?.visible) ? raw.visible : [];
  let best = null;
  for (const entry of vis) {
    if (typeof entry?.dist !== "number" || typeof entry?.label !== "string") continue;
    if (!match.test(entry.label)) continue;
    if (best === null || entry.dist < best.dist) best = entry;
  }
  return best;
}

export function distXZ(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function dist2(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
