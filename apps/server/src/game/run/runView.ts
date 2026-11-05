// @effect-diagnostics globalDate:off nodeBuiltinImport:off -- A question still queued behind a busy chat states its deadline from now; evidence paths are joined to the game root.
// How a run reads to people and tools: its current step, the decision it waits
// on, when a note takes effect, the model its roles run on. Pure over the
// policy's state.
import * as NodePath from "node:path";
import {
  ProviderInstanceId,
  gameRunRoleLabel,
  type GameRunDecision,
  type ModelSelection,
} from "@kurambit/contracts";
import type * as Policy from "./policy.ts";
import type * as State from "./state.ts";

// The question a live run waits on, with its evidence as absolute paths. A question
// still queued behind a busy chat states when its wait would end if it arrived now.
export const decisionOf = (root: string, state: State.RunState): GameRunDecision | null => {
  const step = state.inFlight;
  if (step?.kind !== "decide") return null;
  const d = step.decision;
  const deadline = step.deadline ?? (step.sent === null ? null : Date.now() + d.waitMs);
  return {
    id: d.id,
    kind: d.kind,
    ask: d.ask,
    evidence: d.evidence.map((e) => ({ label: e.label, path: NodePath.join(root, e.path) })),
    text: d.text,
    answers: d.answers.map((a) => ({ answer: a.answer, means: a.means })),
    default: d.fallback,
    deadline: deadline === null ? null : new Date(deadline).toISOString(),
  };
};

export const currentStep = (state: State.RunState): string => {
  const t = state.task;
  const step = state.inFlight?.kind === "pair" ? state.inFlight.halves[0] : state.inFlight;
  if (step?.kind === "role") {
    const label = gameRunRoleLabel(step.role);
    return t._tag === "round" && !label.includes("round") ? `Round ${t.n} · ${label}` : label;
  }
  switch (t._tag) {
    case "init":
      return "Setting up";
    case "stage":
      return t.name === "build" ? "First full build" : gameRunRoleLabel(t.name);
    case "proto":
      return `Prototype ${t.i + 1}`;
    case "pick":
      return "Blind pick of the prototypes";
    case "round":
      return `Round ${t.n} · ${t.phase.replace("-", " ")}`;
    case "ladder":
      return "Plan · writing the ladder";
    case "ship":
      return `Ship review after round ${t.n}`;
    case "leave":
      return "Wrapping up at the budget";
    case "decide":
      return `Waiting for the creator: ${DECISION_LABEL[t.decision.kind]}`;
  }
};

export const DECISION_LABEL: Record<State.Decision["kind"], string> = {
  style: "the vision and look",
  prototype: "which prototype to keep",
  ladder: "the ladder",
};

// When a note takes effect: a round's direction is fixed once it starts.
export const steerWhen = (state: State.RunState | null): string => {
  const t = state?.task;
  if (t?._tag === "round" && t.phase === "start" && state?.inFlight === null)
    return `Round ${t.n} starts with it.`;
  if (t?._tag === "round")
    return `Round ${t.n} is in progress and finishes as planned; round ${t.n + 1} starts with it.`;
  if (t?._tag === "ship")
    return "A ship review is in progress; the next round starts with it before the run can end.";
  if (t?._tag === "ladder") return "The plan is writing the ladder; the next round starts with it.";
  if (t?._tag === "leave") return "The run is ending at its budget; a resumed run starts with it.";
  return "The run is still making its first build; its first round starts with it.";
};

// The game's chosen provider, model and options: the creator's own unless the
// run was started with overrides. A `#variant` suffix is the client's display
// form, not a routable model: launching with it fails every turn at once, so it
// becomes the `variant` option instead (T25: every #xhigh turn failed this way).
export const selectionFor = (
  current: ModelSelection,
  state: Pick<State.RunState, "provider" | "model" | "variant">,
): ModelSelection => {
  let model = state.model ?? current.model;
  let variant = state.variant;
  const suffix = /#([A-Za-z][A-Za-z0-9_-]*)$/.exec(model);
  if (suffix !== null) {
    model = model.slice(0, suffix.index);
    if (variant === null || variant.length === 0) variant = suffix[1] ?? null;
  }
  if ((variant === null || variant.length === 0) && state.model === null && state.provider === null)
    return current;
  // Options belong to a provider: another provider's (Codex effort on an
  // OpenCode model) would make every turn fail, so they carry over only when
  // the provider stays.
  const base =
    state.provider === null || state.provider === current.instanceId ? current.options : [];
  const options =
    variant === null || variant.length === 0
      ? base
      : [
          ...(base ?? []).filter((entry) => entry.id !== "variant"),
          { id: "variant", value: variant },
        ];
  return {
    ...current,
    instanceId:
      state.provider === null ? current.instanceId : ProviderInstanceId.make(state.provider),
    model,
    ...(options === undefined ? {} : { options }),
  };
};

export const describe = (step: State.Step): string => {
  if (step.kind === "pair") return step.halves.map(describe).join(" | ");
  if (step.kind === "role")
    return `step ${step.id}: ${step.role}${step.thread === null ? "" : " (follow-up)"}${step.at === null ? "" : ` at ${step.at.slice(0, 12)}`}`;
  if (step.kind === "git") return `step ${step.id}: git ${step.op._tag}`;
  if (step.kind === "bot") return `step ${step.id}: bot ${step.file} at ${step.sha.slice(0, 12)}`;
  if (step.kind === "decide") return `step ${step.id}: ask the creator (${step.decision.id})`;
  return `step ${step.id}: ${step.kind}`;
};
export const summarize = (res: Policy.StepResult): string => {
  if (res.kind === "done") return `done${res.timedOut ? " (capped)" : ""} on ${res.threadId}`;
  if (res.kind === "git")
    return `git ok=${res.git.ok} ${res.git.branch} ${res.git.sha.slice(0, 8)} ${res.git.detail}`.trim();
  if (res.kind === "boot") return `boot ${res.ok ? "clean" : `failed: ${res.detail}`}`;
  if (res.kind === "ended" || res.kind === "failed") return `${res.kind}: ${res.reason}`;
  if (res.kind === "decided") return `decided ${res.answer} (${res.by})`;
  if (res.kind === "checks")
    return res.results
      .map((c) => `check ${c.k + 1} ${c.pass ? "PASS" : "FAIL"}: ${c.evidence}`)
      .join(" | ");
  if (res.kind === "bot")
    return `bot ${res.fact.ending} after ${res.fact.seconds.toFixed(0)}s ${JSON.stringify(res.fact.final)} ${res.fact.note}`.trim();
  return res.kind;
};
