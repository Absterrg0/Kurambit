import { describe, expect, it } from "@effect/vitest";
import { packSheets, picturePage } from "./pictures.ts";

describe("picturePage", () => {
  it("escapes row values into the template and names the keys a row lacks", () => {
    const { html, missing } = picturePage(
      "<b>{{title}}</b><i>{{ rank }}</i>{{gone}}",
      { name: "a", title: '<script>alert("x")</script>', rank: 7 },
      [64, 32],
    );
    expect(html).toContain("<b>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</b><i>7</i>");
    expect(html).not.toContain("<script>alert");
    expect(missing).toEqual(["gone"]);
  });

  it("keeps a closing script tag in a row from ending window.row early", () => {
    const { html } = picturePage("<p></p>", { name: "a", note: "</script><b>" }, [8, 8]);
    expect(html).toContain('"note":"\\u003c/script>\\u003cb>"');
  });
});

describe("packSheets", () => {
  it("lays pictures in cells within the side, spilling into more sheets", () => {
    const picture = { width: 10, height: 10, data: new Uint8Array(400).fill(255) };
    const { sheets, placed } = packSheets(
      Array.from({ length: 5 }, () => picture),
      [10, 10],
      30,
    );
    // A 14 px cell (2 px gutter each side): two across and two down in a 30 px sheet.
    expect(sheets.map((sheet) => [sheet.width, sheet.height])).toEqual([
      [28, 28],
      [14, 14],
    ]);
    expect(placed[4]).toEqual({ image: 1, x: 2, y: 2 });
    expect(sheets[0]!.data[0]).toBe(0);
  });
});
