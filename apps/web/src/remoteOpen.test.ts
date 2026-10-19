import { buildRemoteOpenUrl } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

describe("buildRemoteOpenUrl", () => {
  it("builds a vscode-remote deep link", () => {
    expect(
      buildRemoteOpenUrl({
        editor: "vscode",
        host: "sol.tail1234.ts.net",
        absolutePath: "/home/theo/code/my repo",
      }),
    ).toBe("vscode://vscode-remote/ssh-remote+sol.tail1234.ts.net/home/theo/code/my%20repo");
  });

  it("uses the fork's scheme", () => {
    expect(buildRemoteOpenUrl({ editor: "cursor", host: "sol", absolutePath: "/tmp/x" })).toBe(
      "cursor://vscode-remote/ssh-remote+sol/tmp/x",
    );
  });

  it("roots Windows paths", () => {
    expect(
      buildRemoteOpenUrl({ editor: "vscode", host: "sol", absolutePath: "C:\\Users\\theo" }),
    ).toBe("vscode://vscode-remote/ssh-remote+sol/C%3A/Users/theo");
  });

  it("builds Zed's ssh deep link", () => {
    expect(
      buildRemoteOpenUrl({
        editor: "zed",
        host: "sol.tail1234.ts.net",
        absolutePath: "/home/theo/code/my repo",
      }),
    ).toBe("zed://ssh/sol.tail1234.ts.net/home/theo/code/my%20repo");
  });

  it("drops the Windows drive letter for Zed", () => {
    expect(
      buildRemoteOpenUrl({ editor: "zed", host: "sol", absolutePath: "C:\\Users\\theo" }),
    ).toBe("zed://ssh/sol/Users/theo");
    expect(buildRemoteOpenUrl({ editor: "zed", host: "sol", absolutePath: "/C:/project" })).toBe(
      "zed://ssh/sol/C%3A/project",
    );
  });

  it("builds a Toolbox ssh deep link for JetBrains IDEs", () => {
    expect(
      buildRemoteOpenUrl({
        editor: "pycharm",
        host: "sol.tail1234.ts.net",
        absolutePath: "/home/theo/code/my repo",
      }),
    ).toBe(
      "jetbrains://gateway/ssh/environment?h=sol.tail1234.ts.net&launchIde=true&ideHint=PY&projectHint=%2Fhome%2Ftheo%2Fcode%2Fmy+repo",
    );
    expect(
      buildRemoteOpenUrl({ editor: "idea", host: "sol", absolutePath: "C:\\Users\\theo" }),
    ).toBe(
      "jetbrains://gateway/ssh/environment?h=sol&launchIde=true&ideHint=IU&projectHint=C%3A%2FUsers%2Ftheo",
    );
  });

  it("returns undefined for editors without remote support", () => {
    expect(buildRemoteOpenUrl({ editor: "kiro", host: "sol", absolutePath: "/tmp/x" })).toBe(
      undefined,
    );
  });
});
