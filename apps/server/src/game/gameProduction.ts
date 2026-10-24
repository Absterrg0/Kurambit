import type { GameProduction, GameProductionStatus, RunId } from "@t3tools/contracts";

/**
 * The production phase before a builder has submitted anything. It is also the
 * decoded shape of a record written before production existed.
 */
export const EMPTY_GAME_PRODUCTION: GameProduction = {
  firstPlayableAt: null,
  firstPlayableBuildId: null,
  runId: null,
  turnFirstSubmitAt: null,
  turnLastSubmitAt: null,
  submissions: 0,
};

/**
 * The builder's time box, as status reads it. Budget is advisory: the server
 * never ends a turn when it runs out, so `remainingMs` reaching zero is news for
 * the model, not a deadline. A finished turn stops counting at its last submit;
 * only the turn that is running spends wall time.
 */
export const productionStatus = (input: {
  readonly production: GameProduction | null | undefined;
  readonly budgetMs: number;
  readonly activeRun: RunId | null;
  readonly nowMs: number;
}): GameProductionStatus => {
  const production = input.production ?? EMPTY_GAME_PRODUCTION;
  // A new builder turn starts with no declarations of its own: until its first
  // accepted submit, the previous turn's span is history, not its clock.
  const ownTurn =
    input.activeRun === null ||
    (production.runId !== null && String(production.runId) === String(input.activeRun));
  const turn = ownTurn
    ? production
    : {
        ...production,
        runId: null,
        turnFirstSubmitAt: null,
        turnLastSubmitAt: null,
        submissions: 0,
      };
  const first = turn.turnFirstSubmitAt === null ? null : Date.parse(turn.turnFirstSubmitAt);
  const last = turn.turnLastSubmitAt === null ? null : Date.parse(turn.turnLastSubmitAt);
  const live = first !== null && input.activeRun !== null && ownTurn;
  const until = live ? input.nowMs : (last ?? first);
  const elapsed =
    first === null || until === null || Number.isNaN(first) || Number.isNaN(until)
      ? 0
      : Math.max(0, until - first);
  return {
    ...turn,
    budgetMs: input.budgetMs,
    elapsedMs: elapsed,
    remainingMs: Math.max(0, input.budgetMs - elapsed),
  };
};

/** "18 of 45 minutes left" — the same phrase in the submit answer and in status. */
export const productionBudgetText = (budgetMs: number, remainingMs: number): string => {
  const total = Math.max(1, Math.round(budgetMs / 60_000));
  const left = Math.max(0, Math.ceil(remainingMs / 60_000));
  return `${left} of ${total} minutes left`;
};
