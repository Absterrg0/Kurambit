// A scripted player for capture and measurement (index.html?autopilot), like round 2's
// --playtest driver: it walks the path, fights each bandit with combos and dodges, climbs the
// stairs and reaches the temple, steering only through the hero's own inputs.
import * as THREE from "../vendor/three.module.js";
import { path, STAIR_A } from "./level.js";

export function createAutopilot(run) {
  const route = [];
  for (let i = 2; i < path.length; i += 3) route.push(new THREE.Vector3(path[i].x, 0, path[i].z));
  route.push(new THREE.Vector3(STAIR_A.x, 0, STAIR_A.z - 2), new THREE.Vector3(0, 0, -24), new THREE.Vector3(0, 0, -34.5), new THREE.Vector3(0, 0, -38.8));
  let at = 0;
  let stall = 0;
  let last = new THREE.Vector3();
  let detour = 0;
  let side = 1;
  let think = 0;
  let rolled = false;
  let counter = 0;
  const out = { wish: new THREE.Vector3(), flags: { sprint: false, walk: false } };
  return {
    get waypoint() {
      return at;
    },
    update(dt) {
      const hero = run.hero;
      out.wish.set(0, 0, 0);
      out.flags.sprint = false;
      if (!hero.alive()) return out;
      think -= dt;
      // a fight: the nearest living bandit within 7 m
      const foe = run.bandits.filter((b) => b.alive() && b.pos.distanceTo(hero.pos) < 7).sort((a, b) => a.pos.distanceTo(hero.pos) - b.pos.distanceTo(hero.pos))[0];
      if (foe !== undefined) {
        // like a player, it reads most wind-ups and misses some
        if (foe.state === "attack" && foe.t < 0.1) foe.read = Math.random() < 0.85;
        const to = new THREE.Vector3(foe.pos.x - hero.pos.x, 0, foe.pos.z - hero.pos.z);
        const d = to.length();
        if (foe.state === "attack" && foe.t > 0.42 && foe.t < 0.62 && d < 3.4 && hero.state !== "step" && foe.read !== false) {
          hero.requestStep();
          counter = 0.3; // strike back out of the step's recovery
          // step to the side, away from the cut
          out.wish.set(-to.z, 0, to.x).normalize().multiplyScalar(Math.random() < 0.5 ? 1 : -1);
          think = 0.5;
        } else if (d > 2.6) out.wish.copy(to.normalize());
        else {
          // patient: strike into openings (a recovering or staggered foe, a long cooldown), else
          // hold the edge of reach and drift around him
          const opening = foe.state === "recover" || foe.state === "hit" || (foe.state === "circle" && foe.cooldown > 0.9);
          if (counter > 0 && (counter -= dt) <= 0) hero.requestAttack();
          if (opening && think <= 0 && hero.state === "move") {
            if (d > 2.4) out.wish.copy(to.normalize());
            else {
              hero.requestAttack();
              think = 0.12;
            }
          } else if (hero.state === "attack" && hero.combo === 0 && hero.t > 0.18) hero.requestAttack();
          else out.wish.set(-to.z, 0, to.x).normalize().multiplyScalar(0.35).addScaledVector(to.normalize(), d < 2.2 ? -0.4 : 0);
        }
        return out;
      }
      const target = route[Math.min(at, route.length - 1)];
      const to = new THREE.Vector3(target.x - hero.pos.x, 0, target.z - hero.pos.z);
      if (to.length() < 1.2 && at < route.length - 1) at++;
      out.wish.copy(to.normalize());
      // a player sprints the open stretches between fights and rolls now and then
      const ahead = run.bandits.some((b) => b.alive() && b.pos.distanceTo(hero.pos) < 16);
      out.flags.sprint = !ahead && at >= 8 && at < 12;
      if (at === 4 && !rolled) {
        hero.requestRoll();
        rolled = true;
      }
      // stalled against something: side-step a moment, as a player would
      stall += dt;
      if (stall > 0.6) {
        if (hero.pos.distanceTo(last) < 0.25 && detour <= 0) {
          detour = 0.7;
          side = -side;
        }
        last.copy(hero.pos);
        stall = 0;
      }
      if (detour > 0) {
        detour -= dt;
        out.wish.applyAxisAngle(new THREE.Vector3(0, 1, 0), side * 1.3);
      }
      return out;
    },
  };
}
