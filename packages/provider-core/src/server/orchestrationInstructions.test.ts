import { assert, describe, it } from "@effect/vitest";

import {
  KURAMBIT_ORCHESTRATION_INSTRUCTIONS,
  kurambitAcpPromptWithInstructions,
  kurambitOrchestrationPromptForFirstRun,
  kurambitOrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("Kurambit orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(KURAMBIT_ORCHESTRATION_INSTRUCTIONS, "Use `delegate_task`");
    assert.include(
      KURAMBIT_ORCHESTRATION_INSTRUCTIONS,
      "ordinary top-level Kurambit conversations",
    );
    assert.include(KURAMBIT_ORCHESTRATION_INSTRUCTIONS, "Never use them merely");
    assert.include(KURAMBIT_ORCHESTRATION_INSTRUCTIONS, "cross-provider");
    assert.include(KURAMBIT_ORCHESTRATION_INSTRUCTIONS, "call `delegate_task` again");
    assert.include(
      KURAMBIT_ORCHESTRATION_INSTRUCTIONS,
      "Do not use `kurambit_thread_send` on `childThreadId`",
    );
  });

  it("injects prompt fallback only for an MCP-enabled first run", () => {
    const prompt = "Inspect the repository.";
    const injected = kurambitOrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 1,
      hasKurambitMcp: true,
    });

    assert.include(injected, "<kurambit_orchestration_instructions>");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      kurambitOrchestrationPromptForFirstRun({ prompt, runOrdinal: 2, hasKurambitMcp: true }),
      prompt,
    );
    assert.equal(
      kurambitOrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasKurambitMcp: false }),
      prompt,
    );
  });

  it("only exposes the system prompt when the Kurambit MCP server is attached", () => {
    assert.equal(kurambitOrchestrationSystemPrompt(false), undefined);
    assert.equal(kurambitOrchestrationSystemPrompt(true), KURAMBIT_ORCHESTRATION_INSTRUCTIONS);
  });

  it("gives ACP sessions provider-neutral mode, browser, and orchestration guidance", () => {
    const injected = kurambitAcpPromptWithInstructions({
      prompt: "Inspect the repository.",
      state: { interactionMode: "default", hasKurambitMcp: true },
    });

    assert.include(injected, "Kurambit interaction mode: Default");
    assert.include(injected, "Kurambit collaborative browser");
    assert.include(injected, "Kurambit orchestration");
    assert.include(injected, "<user_request>\nInspect the repository.\n</user_request>");
  });

  it("reinjects ACP guidance only when mode or tool availability changes", () => {
    const prompt = "Continue.";
    const defaultState = { interactionMode: "default", hasKurambitMcp: true } as const;

    assert.equal(
      kurambitAcpPromptWithInstructions({
        prompt,
        state: defaultState,
        previousState: defaultState,
      }),
      prompt,
    );
    assert.include(
      kurambitAcpPromptWithInstructions({
        prompt,
        state: { ...defaultState, interactionMode: "plan" },
        previousState: defaultState,
      }),
      "Kurambit interaction mode: Plan",
    );
    const withoutMcp = kurambitAcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasKurambitMcp: false },
    });
    assert.include(withoutMcp, "Kurambit interaction mode: Default");
    assert.notInclude(withoutMcp, "Kurambit collaborative browser");
    assert.notInclude(withoutMcp, "Kurambit orchestration");
  });

  it("carries a thread's harness rules, and resends ACP guidance when they change", () => {
    const rules = "## Every turn\n\n- One visible change per turn.";
    const state = { interactionMode: "default", hasKurambitMcp: false } as const;
    assert.include(
      kurambitOrchestrationPromptForFirstRun({
        prompt: "Make this game.",
        runOrdinal: 1,
        hasKurambitMcp: false,
        harnessInstructions: rules,
      }),
      "One visible change per turn.",
    );
    assert.include(kurambitOrchestrationSystemPrompt(true, rules) ?? "", "Kurambit orchestration");
    assert.include(kurambitOrchestrationSystemPrompt(false, rules) ?? "", rules);
    assert.include(
      kurambitAcpPromptWithInstructions({
        prompt: "Continue.",
        state: { ...state, harnessInstructions: rules },
        previousState: state,
      }),
      rules,
    );
  });
});
