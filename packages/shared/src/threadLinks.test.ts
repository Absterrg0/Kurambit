import { describe, expect, it } from "vite-plus/test";

import { formatThreadLink, parseThreadLinkHref, relabelThreadLinks } from "./threadLinks.ts";

describe("thread links", () => {
  it("takes the thread id verbatim, percent escapes included", () => {
    expect(parseThreadLinkHref("kurambit-thread://v1/mcp:1234")).toBe("mcp:1234");
    expect(parseThreadLinkHref("kurambit-thread://v1/thread:delegated-task:mcp%3A1")).toBe(
      "thread:delegated-task:mcp%3A1",
    );
  });

  it("rejects other links and an empty id", () => {
    expect(parseThreadLinkHref("https://example.com")).toBeNull();
    expect(parseThreadLinkHref("kurambit-thread://v1/")).toBeNull();
    expect(parseThreadLinkHref("kurambit-thread://v1/ ")).toBeNull();
  });

  it("resolves a percent-encoded id when the id as written names no thread", () => {
    const titles = new Map([
      ["thread:project:1", "Decoded"],
      ["provider%3A1", "Literal escape"],
    ]);
    expect(
      relabelThreadLinks(
        "[a](kurambit-thread://v1/thread%3Aproject%3A1) [b](kurambit-thread://v1/provider%3A1)",
        (threadId) => titles.get(threadId),
      ),
    ).toBe(
      "[Decoded](kurambit-thread://v1/thread:project:1) [Literal escape](kurambit-thread://v1/provider%3A1)",
    );
    const untitled = new Map([
      ["a%3A1", ""],
      ["a:1", "Other"],
    ]);
    expect(
      relabelThreadLinks("[Kept](kurambit-thread://v1/a%3A1)", (threadId) =>
        untitled.get(threadId),
      ),
    ).toBe("[Kept](kurambit-thread://v1/a%3A1)");
  });

  it("leaves links inside code spans and fences as written", () => {
    const markdown = [
      "Live [old](kurambit-thread://v1/t1), literal `[old](kurambit-thread://v1/t1)`.",
      "```md",
      "[old](kurambit-thread://v1/t1)",
      "```",
      "After [old](kurambit-thread://v1/t1)",
    ].join("\n");
    expect(relabelThreadLinks(markdown, () => "New")).toBe(
      [
        "Live [New](kurambit-thread://v1/t1), literal `[old](kurambit-thread://v1/t1)`.",
        "```md",
        "[old](kurambit-thread://v1/t1)",
        "```",
        "After [New](kurambit-thread://v1/t1)",
      ].join("\n"),
    );
  });

  it("formats a label that would otherwise break the Markdown link", () => {
    expect(formatThreadLink("t1", "Fix [ci] \\ build")).toBe(
      "[Fix ci build](kurambit-thread://v1/t1)",
    );
    expect(formatThreadLink("t1", " ] ")).toBe("[t1](kurambit-thread://v1/t1)");
  });

  it("relabels links with the current title and leaves unknown threads alone", () => {
    const titles = new Map([["renamed", "Fix [the] build\nnow"]]);
    expect(
      relabelThreadLinks(
        "See [Old name](kurambit-thread://v1/renamed) and [Gone](kurambit-thread://v1/deleted).",
        (threadId) => titles.get(threadId),
      ),
    ).toBe(
      "See [Fix the build now](kurambit-thread://v1/renamed) and [Gone](kurambit-thread://v1/deleted).",
    );
  });
});
