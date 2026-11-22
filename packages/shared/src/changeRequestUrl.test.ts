import { describe, expect, it } from "vite-plus/test";

import { parseChangeRequestUrl } from "./changeRequestUrl.ts";

describe("parseChangeRequestUrl", () => {
  it("reads a GitHub pull request, lower-casing the repository", () => {
    expect(parseChangeRequestUrl("https://github.com/Absterrg0/Kurambit/pull/123")).toEqual({
      host: "github.com",
      repository: "absterrg0/kurambit",
      number: 123,
    });
  });

  it("reads a pull request on a GitHub Enterprise host", () => {
    expect(parseChangeRequestUrl("https://github.acme.test/platform/api/pull/7")).toEqual({
      host: "github.acme.test",
      repository: "platform/api",
      number: 7,
    });
  });

  it("reads Forgejo URLs even when the hostname contains github", () => {
    expect(parseChangeRequestUrl("https://github.internal/team/repo/pulls/7")).toEqual({
      host: "github.internal",
      authority: "github.internal",
      repository: "team/repo",
      number: 7,
    });
  });

  it("reads a supported GitHub host with a middle DNS label", () => {
    expect(parseChangeRequestUrl("https://code.github.example.com/acme/web/pull/42")).toEqual({
      host: "code.github.example.com",
      repository: "acme/web",
      number: 42,
    });
  });

  it("reads a GitLab merge request on any host, nested groups and all", () => {
    expect(
      parseChangeRequestUrl("https://gitlab.com/kurambit/platform/kurambit/-/merge_requests/42"),
    ).toEqual({ host: "gitlab.com", repository: "kurambit/platform/kurambit", number: 42 });
    expect(parseChangeRequestUrl("https://code.acme.test/team/project/-/merge_requests/9")).toEqual(
      { host: "code.acme.test", repository: "team/project", number: 9 },
    );
  });

  it("reads Bitbucket and both Azure DevOps URL forms", () => {
    expect(parseChangeRequestUrl("https://bitbucket.org/workspace/repo/pull-requests/5")).toEqual({
      host: "bitbucket.org",
      repository: "workspace/repo",
      number: 5,
    });
    expect(
      parseChangeRequestUrl("https://dev.azure.com/acme/platform/_git/kurambit/pullrequest/17"),
    ).toEqual({ host: "dev.azure.com", repository: "acme/platform/_git/kurambit", number: 17 });
    expect(
      parseChangeRequestUrl("https://acme.visualstudio.com/platform/_git/kurambit/pullrequest/17"),
    ).toEqual({ host: "acme.visualstudio.com", repository: "platform/_git/kurambit", number: 17 });
  });

  it("survives trailing segments, a trailing slash and a query string", () => {
    expect(
      parseChangeRequestUrl("https://github.com/Absterrg0/Kurambit/pull/123/files?w=1"),
    ).toEqual({
      host: "github.com",
      repository: "absterrg0/kurambit",
      number: 123,
    });
    expect(parseChangeRequestUrl("https://github.com/Absterrg0/Kurambit/pull/123/")).toEqual({
      host: "github.com",
      repository: "absterrg0/kurambit",
      number: 123,
    });
  });

  it("claims nothing it cannot be sure of", () => {
    for (const link of [
      "https://github.com/Absterrg0/Kurambit/issues/123",
      "https://github.com/Absterrg0/Kurambit/commit/0a1b2c3",
      "https://github.com/Absterrg0/Kurambit",
      "https://github.com/Absterrg0/Kurambit/pull/abc",
      "https://gitlab.com/Absterrg0/Kurambit/-/issues/12",
      "https://blog.example.test/2026/updates/pull/3",
      "javascript:alert(1)//github.com/Absterrg0/Kurambit/pull/1",
      "not a url",
    ]) {
      expect(parseChangeRequestUrl(link), link).toBeNull();
    }
  });
});

describe("siblingPullRequestUrl", () => {
  it("recognizes Forgejo on custom HTTP hosts", () => {
    expect(parseChangeRequestUrl("http://git.example.test:3000/team/repo/pulls/42/files")).toEqual({
      host: "git.example.test",
      authority: "git.example.test:3000",
      repository: "team/repo",
      number: 42,
    });
  });
});
