import { gameRunRoleLabel, type GameRunExposure, type GameRunThreadRef } from "@kurambit/contracts";

import { formatElapsedSeconds } from "../chat/AgentElapsed";

export interface RoleThreadGroup {
  readonly label: string;
  readonly threads: ReadonlyArray<GameRunThreadRef>;
}

/** Role threads in launch order, grouped by the run stage or round the server says each ran in. */
export const groupRoleThreads = (
  threads: ReadonlyArray<GameRunThreadRef>,
): ReadonlyArray<RoleThreadGroup> => {
  const groups: Array<{ label: string; threads: GameRunThreadRef[] }> = [];
  for (const thread of threads) {
    const last = groups.at(-1);
    if (last?.label === thread.group) last.threads.push(thread);
    else groups.push({ label: thread.group, threads: [thread] });
  }
  return groups;
};

/** "A · Prototype 2" for a pick's blind label, the label alone when its branch is unknown. */
export const pickSideLabel = (
  build: string,
  sides: ReadonlyArray<{ readonly build: string; readonly branch: string }>,
): string => {
  const branch = sides.find((side) => side.build === build)?.branch;
  return branch === undefined ? build : `${build} · ${gameRunRoleLabel(branch)}`;
};

/** What a blind player saw of its build, in one line. */
export const exposureLine = (exposure: GameRunExposure): string =>
  [
    `${exposure.sessions} session${exposure.sessions === 1 ? "" : "s"}`,
    `${exposure.actions} action${exposure.actions === 1 ? "" : "s"}`,
    `${formatElapsedSeconds(exposure.nominalMs / 1000)} of input`,
    `${exposure.images} frame${exposure.images === 1 ? "" : "s"}`,
  ].join(" · ");

export const formatRunDuration = (ms: number): string => {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 60)
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
  return minutes >= 1 ? `${minutes} min` : `${Math.max(0, Math.round(ms / 1000))}s`;
};
