import { describe, expect, it } from "vite-plus/test";

import { shouldUseMarkdownFileBrowserPrimaryAction } from "./ChatMarkdown";

describe("shouldUseMarkdownFileBrowserPrimaryAction", () => {
  const html = { iconPath: "/tmp/report.html", canOpenInBrowser: true };

  it("uses the browser only when it is the sole action, except for PDFs", () => {
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        ...html,
        canOpenInEditor: false,
        canOpenInPanel: false,
      }),
    ).toBe(true);
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        ...html,
        canOpenInEditor: true,
        canOpenInPanel: false,
      }),
    ).toBe(false);
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        ...html,
        canOpenInEditor: false,
        canOpenInPanel: true,
      }),
    ).toBe(false);
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        iconPath: "/tmp/report.pdf",
        canOpenInEditor: true,
        canOpenInBrowser: true,
        canOpenInPanel: true,
      }),
    ).toBe(true);
  });
});
