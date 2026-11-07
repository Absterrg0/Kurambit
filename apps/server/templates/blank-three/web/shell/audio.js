// Sound through three Web Audio gain nodes, so the settings sliders reach
// every sound: master <- music, master <- sfx.
//
//   playMusic("./assets/music/theme.ogg");   // looped on the music gain; replaces the last track
//   stopMusic();
//   playSfx("./assets/sfx/hit.wav", { volume: 0.8, pitch: 0.08 }); // or Juice.sfx(...)
//   playAmbience("./assets/sfx/wind.ogg", { volume: 0.5 }); // a looped bed beside the music
//   stopAmbience();                                         // (wind, rain, a room's hum)
//
// Browsers start audio only after a click or key press, so the context is made
// on the first one (the shell also tries on a gamepad button); sounds asked for
// before that are skipped, and music and ambience asked for before that start then.
// The ambience bed is its own channel under the sound-effects volume: one bed
// at a time, and a new one crossfades from the last (asking for the playing bed
// again changes only its volume).

export const VOLUME_NAMES = ["master", "music", "sfx"];
const MAX_VOICES = 12;

const volumes = { master: 1, music: 1, sfx: 1 };
let context = null;
// The studio's hidden-tab hold (holdAudio), kept apart from the context state.
let held = false;
let gains = null;
const buffers = new Map();
const voices = [];
let musicUrl = null;
let musicSource = null;
let musicToken = 0;

/** Makes or resumes the audio context; the shell calls it on gamepad presses. */
export function unlockAudio() {
  if (context !== null) {
    if (context.state === "suspended" && !held) context.resume().catch(() => undefined);
    return;
  }
  const Context = window.AudioContext ?? window.webkitAudioContext;
  if (Context === undefined) return;
  context = new Context();
  const master = context.createGain();
  master.connect(context.destination);
  const music = context.createGain();
  music.connect(master);
  const sfx = context.createGain();
  sfx.connect(master);
  gains = { master, music, sfx };
  for (const name of VOLUME_NAMES) gains[name].gain.value = volumes[name];
  if (held) context.suspend().catch(() => undefined);
  if (musicUrl !== null) playMusic(musicUrl);
  if (bedUrl !== null) startBed();
}
window.addEventListener("pointerdown", unlockAudio, { capture: true });
window.addEventListener("keydown", unlockAudio, { capture: true });

export function setVolume(name, value) {
  volumes[name] = Math.min(1, Math.max(0, Number(value) || 0));
  if (gains !== null) gains[name].gain.setTargetAtTime(volumes[name], context.currentTime, 0.02);
}

export function getVolume(name) {
  return volumes[name];
}

function load(url) {
  let pending = buffers.get(url);
  if (pending === undefined) {
    pending = fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`No sound at ${url} (${response.status}).`);
        return response.arrayBuffer();
      })
      .then((bytes) => context.decodeAudioData(bytes));
    buffers.set(url, pending);
    pending.catch((error) => console.error(String(error?.message ?? error)));
  }
  return pending;
}

function start(buffer, output, { volume = 1, pitch = 0, loop = false } = {}) {
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.loop = loop;
  source.playbackRate.value = 1 + (Math.random() * 2 - 1) * pitch;
  const level = context.createGain();
  level.gain.value = volume;
  source.connect(level).connect(output);
  source.start();
  return source;
}

/** A one-shot on the sfx gain, a fresh slight pitch each time; the oldest of too many voices stops. */
export function playSfx(sound, { volume = 1, pitch = 0.08 } = {}) {
  if (context === null || context.state !== "running") return;
  const play = (buffer) => {
    if (voices.length >= MAX_VOICES) voices.shift()?.stop();
    const source = start(buffer, gains.sfx, { volume, pitch });
    voices.push(source);
    source.addEventListener("ended", () => {
      const at = voices.indexOf(source);
      if (at >= 0) voices.splice(at, 1);
    });
  };
  if (sound instanceof AudioBuffer) play(sound);
  else load(String(sound)).then(play, () => undefined);
}

export function playMusic(url, { volume = 1 } = {}) {
  musicUrl = url;
  const token = ++musicToken;
  musicSource?.stop();
  musicSource = null;
  if (context === null) return;
  load(url).then(
    (buffer) => {
      if (token === musicToken) musicSource = start(buffer, gains.music, { volume, loop: true });
    },
    () => undefined,
  );
}

export function stopMusic() {
  musicUrl = null;
  musicToken += 1;
  musicSource?.stop();
  musicSource = null;
}

let bedUrl = null;
let bedVolume = 1;
let bedFade = 1;
let bed = null;
let bedToken = 0;

const fadeTo = (level, value, seconds) => {
  const now = context.currentTime;
  level.gain.cancelScheduledValues(now);
  level.gain.setValueAtTime(level.gain.value, now);
  level.gain.linearRampToValueAtTime(value, now + Math.max(seconds, 0.01));
};

function startBed() {
  const token = ++bedToken;
  const url = bedUrl;
  load(url).then(
    (buffer) => {
      if (token !== bedToken || context === null) return;
      if (bed !== null) {
        const old = bed;
        fadeTo(old.level, 0, bedFade);
        old.source.stop(context.currentTime + bedFade + 0.05);
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const level = context.createGain();
      level.gain.value = 0;
      source.connect(level).connect(gains.sfx);
      source.start();
      fadeTo(level, bedVolume, bedFade);
      bed = { url, source, level };
    },
    () => undefined,
  );
}

/** Loops an ambience bed under the sound-effects volume, crossfading from the last one. */
export function playAmbience(url, { volume = 1, fade = 1 } = {}) {
  bedVolume = volume;
  bedFade = fade;
  if (bedUrl === url && bed?.url === url && context !== null) {
    fadeTo(bed.level, volume, fade);
    return;
  }
  bedUrl = url;
  if (context !== null) startBed();
}

/** Fades the ambience bed out. */
export function stopAmbience({ fade = 1 } = {}) {
  bedUrl = null;
  bedToken += 1;
  if (bed === null || context === null) return;
  fadeTo(bed.level, 0, fade);
  bed.source.stop(context.currentTime + fade + 0.05);
  bed = null;
}

/** A short synthesized tick for menu presses, so the shell sounds before any file exists. */
export function playTick() {
  if (context === null || held) return;
  // A context left suspended (made from a gamepad press, or after a hold)
  // resumes on this press, so the first menu tick still sounds.
  if (context.state !== "running") {
    context.resume().then(
      () => context.state === "running" && tick(),
      () => undefined,
    );
    return;
  }
  tick();
}

function tick() {
  const tone = context.createOscillator();
  const level = context.createGain();
  tone.frequency.value = 880;
  level.gain.setValueAtTime(0.12, context.currentTime);
  level.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.05);
  tone.connect(level).connect(gains.sfx);
  tone.start();
  tone.stop(context.currentTime + 0.06);
}

/** The studio's hidden-tab hold: suspends all sound, then puts back what it found. Returns muted. */
export function holdAudio(on) {
  held = on;
  if (context !== null) (on ? context.suspend() : context.resume()).catch(() => undefined);
  return on;
}
