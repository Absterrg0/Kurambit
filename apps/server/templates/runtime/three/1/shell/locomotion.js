// A locomotion state machine on top of animate(): tell it every frame what the
// body did, and it picks idle, walk or run by speed (with hysteresis, so a
// character at the threshold does not flicker between clips), takes off,
// hangs and lands in the air, and plays one-shot moves the loop resumes after.
//
//   import { locomotion } from "./shell/locomotion.js";
//   const loco = locomotion(hero, { walk: 0.2, run: 3.2 }); // thresholds in m/s
//   // every frame in update(dt, ctx), with the speed the body really moved:
//   loco.update({ speed, grounded, vy, dt });              // vy: vertical speed, + up
//   if (ctx.input.pressed("action")) loco.act("attack");   // a clip word the model carries
//   loco.state;  // "idle" | "walk" | "run" | "air" | "land" | the move
//   loco.acting; // true while a move from act() plays
//
// Walk and run pass the speed as moveSpeed, so a model exported through the
// pipeline plays at its measured ground speed and its feet stay planted.
export function locomotion(
  animator,
  { walk = 0.2, run = 3.2, band = 0.4, air = "jump", land = "land" } = {},
) {
  let state = "idle";
  let wasGrounded = true;
  let move = null; // { name, until }
  let clock = 0;
  let landUntil = 0;
  // Reused every frame: update() runs per character per frame.
  const still = {};
  const moving = { moveSpeed: 0 };
  const rising = { once: true, speed: 1 };
  const falling = { once: true, speed: 0.6 };
  const landing = { once: true, speed: 2.2, fade: 0.06 };
  return {
    get state() {
      return move !== null ? move.name : state;
    },
    /** A one-shot move by clip word; it plays through (or for `seconds`), then the loop resumes. */
    act(name, seconds = null) {
      move = { name, until: seconds === null ? Infinity : clock + seconds };
      animator.play(name, { once: true, fade: 0.08 });
    },
    get acting() {
      return move !== null;
    },
    update({ speed = 0, grounded = true, vy = 0, dt = 1 / 60 } = {}) {
      clock += dt;
      // A move ends when animate has gone back to the loop, or its time is up.
      if (move !== null && (animator.state !== move.name || clock >= move.until)) move = null;
      const up = state === "run" ? run - band : run;
      const ground = speed > up ? "run" : speed > walk ? "walk" : "idle";
      moving.moveSpeed = speed;
      const groundOptions = ground === "idle" ? still : moving;
      if (move !== null) {
        // Keep asking for the loop: animate plays it once the move is through.
        animator.play(ground, groundOptions);
      } else if (!grounded) {
        state = "air";
        animator.play(air, vy > 0 ? rising : falling);
      } else if (!wasGrounded) {
        // The landing also cuts the air clip short, which a loop would wait out.
        state = "land";
        landUntil = clock + 0.18;
        animator.play(land, landing);
      } else if (state === "land" && clock < landUntil && speed < walk) {
        animator.play("idle"); // the landing plays through, then idle
      } else {
        state = ground;
        animator.play(state, groundOptions);
      }
      wasGrounded = grounded;
    },
  };
}
