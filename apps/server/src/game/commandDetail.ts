import type { GameProcessResult } from "@kurambit/contracts";

export const commandDetail = (result: GameProcessResult) =>
  `Exit code: ${result.exitCode}${result.timedOut ? " (timed out)" : ""}\n${result.stdout}\n${result.stderr}`.slice(
    -4096,
  );
