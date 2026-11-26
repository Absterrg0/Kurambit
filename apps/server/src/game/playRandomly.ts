// @effect-diagnostics globalDate:off globalTimers:off -- Plays a short random input in real time.
// The masher's verbs (templates/bot-kit/masher.mjs): every shell's movement and action
// keys, never Escape or P (pause).
const DIRECTIONS = [
  ["D", "ArrowRight"],
  ["A", "ArrowLeft"],
  ["W", "ArrowUp"],
  ["S", "ArrowDown"],
] as const;
const TAPS = ["Space", "Shift", "E", "Enter", "J", "K", "Z", "X"] as const;

/**
 * Random input for `ms`, seeded as the masher is so every check plays the same sequence:
 * a direction or two held for 0.3–0.8 s, often with an action key tapped. Keys are let go
 * at the end.
 */
export const playRandomly = async (
  input: (keys: {
    readonly held: readonly string[];
    readonly taps: readonly string[];
    readonly clicks: readonly [];
  }) => Promise<void>,
  ms: number,
  signal?: AbortSignal,
): Promise<void> => {
  let seed = 0x9e3779b9;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = seed;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <A>(list: ReadonlyArray<A>) => list[Math.floor(random() * list.length)]!;
  const until = Date.now() + ms;
  try {
    for (;;) {
      if (Date.now() >= until || signal?.aborted === true) break;
      const held = new Set<string>(pick(DIRECTIONS));
      if (random() < 0.4) for (const key of pick(DIRECTIONS)) held.add(key);
      const taps = random() < 0.6 ? [pick(TAPS)] : [];
      await input({ held: [...held], taps, clicks: [] });
      const wait = Math.min(300 + random() * 500, Math.max(0, until - Date.now()));
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  } finally {
    await input({ held: [], taps: [], clicks: [] });
  }
};
