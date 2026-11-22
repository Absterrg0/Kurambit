import { describe, expect, it } from "vite-plus/test";

import {
  canCreateProjectInEnvironment,
  getCloneDestinationBrowsePath,
  getCloneDestinationPath,
  getCloneDirectoryName,
  normalizePastedCloneUrl,
} from "./projects.ts";

describe("add project shared logic", () => {
  it("only allows project creation in connected environments", () => {
    expect(canCreateProjectInEnvironment("connected")).toBe(true);
    expect(canCreateProjectInEnvironment("available")).toBe(false);
    expect(canCreateProjectInEnvironment("offline")).toBe(false);
    expect(canCreateProjectInEnvironment("connecting")).toBe(false);
    expect(canCreateProjectInEnvironment("reconnecting")).toBe(false);
    expect(canCreateProjectInEnvironment("error")).toBe(false);
  });

  it("derives the clone folder name from the repository name with owner", () => {
    expect(getCloneDirectoryName("owner/repo")).toBe("repo");
    expect(getCloneDirectoryName("org/project/repo")).toBe("repo");
    expect(getCloneDirectoryName("repo")).toBe("repo");
    expect(getCloneDirectoryName("owner/repo/")).toBe("repo");
    expect(getCloneDirectoryName("")).toBe("");
    expect(getCloneDirectoryName(null)).toBe("");
  });

  it("routes owner/repository shorthand to GitHub over HTTPS", () => {
    expect(normalizePastedCloneUrl("imputnet/helium")).toBe(
      "https://github.com/imputnet/helium.git",
    );
    expect(normalizePastedCloneUrl("  Absterrg0/Kurambit  ")).toBe(
      "https://github.com/Absterrg0/Kurambit.git",
    );
  });

  it("keeps explicit clone URLs and local paths unchanged", () => {
    expect(normalizePastedCloneUrl("https://gitlab.com/group/project.git")).toBe(
      "https://gitlab.com/group/project.git",
    );
    expect(normalizePastedCloneUrl("git@github.com:owner/repo.git")).toBe(
      "git@github.com:owner/repo.git",
    );
    expect(normalizePastedCloneUrl("group/subgroup/project")).toBe("group/subgroup/project");
    expect(normalizePastedCloneUrl("/srv/git/repo.git")).toBe("/srv/git/repo.git");
  });

  it("derives the clone folder name from any pasted clone URL", () => {
    expect(getCloneDirectoryName("https://github.com/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo/")).toBe("repo");
    expect(getCloneDirectoryName("git@github.com:owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("ssh://git@github.com:22/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://user@bitbucket.org/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://dev.azure.com/org/project/_git/repo")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo.git?ref=main#readme")).toBe("repo");
    expect(getCloneDirectoryName("/srv/git/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("C:\\src\\repo.git")).toBe("repo");
    expect(getCloneDirectoryName("git@github.com:repo.git")).toBe("repo");
    expect(getCloneDirectoryName("  https://github.com/owner/repo.git  ")).toBe("repo");
  });

  it("keeps a numeric repository name that sits on a path", () => {
    expect(getCloneDirectoryName("https://github.com/acme/123.git")).toBe("123");
    expect(getCloneDirectoryName("https://github.com/acme/123")).toBe("123");
    expect(getCloneDirectoryName("git@github.com:acme/123.git")).toBe("123");
  });

  it("proposes no clone folder for a link that names no repository", () => {
    expect(getCloneDirectoryName("https://github.com/")).toBe("");
    expect(getCloneDirectoryName("https://github.com")).toBe("");
    expect(getCloneDirectoryName("git@github.com:")).toBe("");
    expect(getCloneDirectoryName("ssh://git@github.com:22")).toBe("");
    expect(getCloneDirectoryName("https://")).toBe("");
  });

  it("proposes the clone destination inside the selected directory", () => {
    expect(getCloneDestinationPath("~/Projects/", "repo")).toBe("~/Projects/repo");
    expect(getCloneDestinationPath("~/Projects", "repo")).toBe("~/Projects/repo");
    expect(getCloneDestinationPath("C:\\work\\", "repo")).toBe("C:\\work\\repo");
    expect(getCloneDestinationPath("~/Projects/", null)).toBe("~/Projects/");
    expect(getCloneDestinationPath("~/Projects/", "")).toBe("~/Projects/");
  });

  it("keeps pinned clone destinations anchored to the browsed directory", () => {
    expect(
      getCloneDestinationBrowsePath({
        browseDirectoryPath: "~/Projects/",
        selectedDirectoryName: "work",
        cloneDirectoryName: "repo",
        caseSensitive: true,
      }),
    ).toBe("~/Projects/work/repo");
    expect(
      getCloneDestinationBrowsePath({
        browseDirectoryPath: "~/Projects/",
        selectedDirectoryName: "repo",
        cloneDirectoryName: "repo",
        caseSensitive: true,
      }),
    ).toBe("~/Projects/repo/");
    expect(
      getCloneDestinationBrowsePath({
        browseDirectoryPath: "C:\\Projects\\",
        selectedDirectoryName: "Repo",
        cloneDirectoryName: "repo",
        caseSensitive: false,
      }),
    ).toBe("C:\\Projects\\Repo\\");
  });
});
