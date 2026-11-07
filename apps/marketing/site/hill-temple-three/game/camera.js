// The third-person camera: over the right shoulder on a spring arm that shortens against the
// ground, mouse look under pointer lock (or the right stick), auto-follow while running, a soft
// pull toward the engaged foe so a fight stays framed. Round 2's numbers: 4.3 m arm, 62° fov,
// pitch -13°, 0.55 m shoulder offset.
import * as THREE from "../vendor/three.module.js";
import { groundAt } from "./level.js";

export function createThirdPerson(camera) {
  const state = {
    yaw: 0,
    pitch: THREE.MathUtils.degToRad(-13),
    arm: 4.3,
    armNow: 4.3,
    shoulder: 0.55,
    focus: new THREE.Vector3(),
    auto: true,
    override: null, // {yaw, pitch, arm} for scripted shots
  };
  const pivot = new THREE.Vector3();
  const back = new THREE.Vector3();
  const right = new THREE.Vector3();
  const look = new THREE.Vector3();
  return {
    state,
    snap(target, facing) {
      state.yaw = facing;
      state.focus.copy(target).add(new THREE.Vector3(0, 1.55, 0));
      state.armNow = state.arm;
    },
    /** dx/dy: look input this frame (pixels or stick units already scaled). */
    update(dt, target, { lookX = 0, lookY = 0, moving = false, facing = 0, foe = null } = {}) {
      if (lookX !== 0 || lookY !== 0) {
        state.yaw -= lookX;
        state.pitch = THREE.MathUtils.clamp(state.pitch - lookY, -0.8, 0.35);
        state.lastLook = 0;
      }
      state.lastLook = (state.lastLook ?? 0) + dt;
      if (state.auto && moving && state.lastLook > 1.2) {
        // ease behind the hero while he runs, unless the player just steered the view
        const d = Math.atan2(Math.sin(facing - state.yaw), Math.cos(facing - state.yaw));
        state.yaw += d * (1 - Math.exp(-1.6 * dt));
      }
      if (foe !== null && state.lastLook > 0.6) {
        // keep the engaged foe in frame: turn so it sits ahead and a little to the left
        const want = Math.atan2(-(foe.x - target.x), -(foe.z - target.z));
        const d = Math.atan2(Math.sin(want - state.yaw), Math.cos(want - state.yaw));
        if (Math.abs(d) > 0.35) state.yaw += (d - Math.sign(d) * 0.35) * (1 - Math.exp(-3 * dt));
      }
      const o = state.override;
      const yaw = o?.yaw ?? state.yaw;
      const pitch = o?.pitch ?? state.pitch;
      const arm = o?.arm ?? state.arm;
      pivot.copy(target).add(look.set(0, 1.55, 0));
      state.focus.lerp(pivot, 1 - Math.exp(-12 * dt));
      back.set(Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
      right.set(Math.cos(yaw), 0, -Math.sin(yaw));
      // shorten the arm where the ground would cut the view
      let len = arm;
      for (let i = 1; i <= 8; i++) {
        const t = (arm * i) / 8;
        const px = state.focus.x + back.x * t + right.x * state.shoulder;
        const pz = state.focus.z + back.z * t + right.z * state.shoulder;
        const py = state.focus.y + back.y * t;
        if (py < groundAt(px, pz) + 0.35) {
          len = Math.max(1.2, t - arm / 8);
          break;
        }
      }
      state.armNow += (len - state.armNow) * (1 - Math.exp(-(len < state.armNow ? 20 : 4) * dt));
      camera.position.copy(state.focus).addScaledVector(back, state.armNow).addScaledVector(right, state.shoulder);
      const gy = groundAt(camera.position.x, camera.position.z) + 0.3;
      if (camera.position.y < gy) camera.position.y = gy;
      camera.lookAt(look.copy(state.focus).addScaledVector(right, state.shoulder));
    },
    /** The camera's ground-plane yaw, for camera-relative movement. */
    get yaw() {
      return state.override?.yaw ?? state.yaw;
    },
  };
}
