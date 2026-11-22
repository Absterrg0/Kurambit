import { describe, expect, it } from "vite-plus/test";

import { formatThreadLink, parseThreadLinkHref } from "./threadLinks.ts";

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

  it("formats a label that would otherwise break the Markdown link", () => {
    expect(formatThreadLink("t1", "Fix [ci] \\ build")).toBe(
      "[Fix ci build](kurambit-thread://v1/t1)",
    );
    expect(formatThreadLink("t1", " ] ")).toBe("[t1](kurambit-thread://v1/t1)");
  });
});
