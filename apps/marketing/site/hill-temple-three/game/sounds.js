// Every sound the run makes, through the shell's sfx and music gains. Kenney RPG Audio and
// rubberduck's 100 CC0 SFX (both CC0), plus the wind, whooshes, thump and music made in
// scripts/synth_audio.py.
import { playLoop, playSfx, stopMusic } from "../shell/audio.js";

const S = (n) => `./assets/sfx/${n}.ogg`;
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const STEPS = ["00", "01", "02", "03", "04", "05", "06", "07", "08", "09"].map((n) => S(`step_${n}`));

export function createSounds() {
  let stopWind = null;
  return {
    ambience() {
      stopWind = playLoop(S("wind"), { volume: 0.55 });
    },
    footstep(speed, stone) {
      playSfx(pick(STEPS), { volume: Math.min(0.55, 0.22 + speed * 0.06) * (stone ? 0.8 : 1), pitch: stone ? 0.05 : 0.12 });
    },
    swing(n) {
      playSfx(S(n === 0 ? "whoosh_1" : "whoosh_2"), { volume: 0.7, pitch: 0.06 });
      playSfx(S(pick(["cloth_1", "cloth_2"])), { volume: 0.25 });
    },
    hit(n) {
      playSfx(S("chop"), { volume: 0.9, pitch: 0.06 });
      playSfx(S(pick(["slice_1", "slice_2"])), { volume: 0.55 });
      playSfx(S("thump"), { volume: n === 0 ? 0.55 : 0.8, pitch: 0.05 });
      if (n === 1) playSfx(S("metal_1"), { volume: 0.25 });
    },
    hurt() {
      playSfx(S("thud_1"), { volume: 0.8 });
      playSfx(S("chop"), { volume: 0.5, pitch: 0.15 });
    },
    dodge() {
      playSfx(S(pick(["cloth_3", "cloth_4"])), { volume: 0.55 });
      playSfx(pick(STEPS), { volume: 0.45 });
    },
    roll() {
      playSfx(S("cloth_1"), { volume: 0.6 });
      playSfx(S("drop"), { volume: 0.4 });
    },
    aggro() {
      playSfx(S("draw_1"), { volume: 0.55 });
    },
    windup() {
      playSfx(S("metal_2"), { volume: 0.18, pitch: 0.1 });
    },
    fall() {
      playSfx(S("thud_2"), { volume: 0.7 });
      playSfx(S("drop"), { volume: 0.5 });
    },
    death() {
      playSfx(S("thud_2"), { volume: 0.9 });
    },
    win() {
      playSfx(S("gong"), { volume: 0.8, pitch: 0 });
    },
    stop() {
      stopWind?.();
      stopMusic();
    },
  };
}
