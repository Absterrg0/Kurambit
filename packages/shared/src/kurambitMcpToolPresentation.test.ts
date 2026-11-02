import { describe, expect, it } from "vite-plus/test";

import {
  KURAMBIT_MCP_TOOL_NAMES,
  resolveKurambitMcpToolPresentation,
} from "./kurambitMcpToolPresentation.ts";

describe("resolveKurambitMcpToolPresentation", () => {
  it("recognizes every Kurambit tool across provider prefixes and completion suffixes", () => {
    for (const tool of KURAMBIT_MCP_TOOL_NAMES) {
      const presentation = resolveKurambitMcpToolPresentation(tool);
      for (const prefix of [
        "mcp__kurambit__",
        "kurambit.",
        "kurambit/",
        "kurambit:",
        "mcp_kurambit_",
        "Kurambit ",
        "kurambit · ",
      ]) {
        expect(resolveKurambitMcpToolPresentation(`${prefix}${tool} completed`), tool).toEqual(
          presentation,
        );
      }
      expect(resolveKurambitMcpToolPresentation(`mcp__another-server__${tool}`), tool).toBeNull();
    }
  });
  it("pretty prints Claude and Cursor Kurambit MCP tool names", () => {
    expect(resolveKurambitMcpToolPresentation("mcp__kurambit__kurambit_thread_read")).toEqual({
      displayName: "Read a Kurambit thread",
      logo: "kurambit",
    });
  });

  it("pretty prints Codex Kurambit MCP tool names", () => {
    expect(resolveKurambitMcpToolPresentation("kurambit.create_threads")).toEqual({
      displayName: "Create Kurambit threads",
      logo: "kurambit",
    });
  });

  it("pretty prints thread metadata updates", () => {
    expect(resolveKurambitMcpToolPresentation("mcp__kurambit__kurambit_thread_update")).toEqual({
      displayName: "Update Kurambit thread metadata",
      logo: "kurambit",
    });
  });

  it("pretty prints bare Kurambit MCP toolkit names", () => {
    expect(resolveKurambitMcpToolPresentation("list_scheduled_tasks")).toEqual({
      displayName: "List scheduled tasks",
      logo: "kurambit",
    });
  });

  it("pretty prints worktree Kurambit MCP tool names", () => {
    expect(resolveKurambitMcpToolPresentation("mcp__kurambit__kurambit_worktree_handoff")).toEqual({
      displayName: "Hand off thread to a git worktree",
      logo: "kurambit",
    });
    expect(resolveKurambitMcpToolPresentation("kurambit.kurambit_worktree_status")).toEqual({
      displayName: "Get thread worktree status",
      logo: "kurambit",
    });
  });

  it("pretty prints preview Kurambit MCP tool names", () => {
    expect(resolveKurambitMcpToolPresentation("kurambit.preview_open")).toEqual({
      displayName: "Open a page in the preview browser",
      logo: "kurambit",
    });
    expect(resolveKurambitMcpToolPresentation("mcp__kurambit__preview_status")).toEqual({
      displayName: "Get preview browser status",
      logo: "kurambit",
    });
  });

  it("matches the separator variants ACP registry agents emit", () => {
    for (const name of [
      "mcp_kurambit_delegate_task",
      "kurambit:delegate_task",
      "kurambit/delegate_task",
      "kurambit delegate_task",
      "Kurambit delegate_task",
      "kurambit__delegate_task",
    ]) {
      expect(resolveKurambitMcpToolPresentation(name)?.displayName).toBe("Delegate a child task");
    }
  });

  it("matches OpenCode 2's per-thread server names, whose thread ids hold underscores", () => {
    expect(
      resolveKurambitMcpToolPresentation("kurambit-thread_opencode2-adapter_delegate_task")
        ?.displayName,
    ).toBe("Delegate a child task");
    expect(
      resolveKurambitMcpToolPresentation("kurambit-thread_opencode2-adapter_not_a_tool"),
    ).toBeNull();
  });

  it("keeps unknown MCP tools on the generic renderer path", () => {
    expect(resolveKurambitMcpToolPresentation("mcp__github__search_issues")).toBeNull();
    expect(resolveKurambitMcpToolPresentation("kurambit.not_a_real_tool")).toBeNull();
  });
});
