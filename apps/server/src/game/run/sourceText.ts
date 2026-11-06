// A source file's text with its comments blanked, so a path in a doc comment
// or in commented-out code is never read as a file the game loads. Strings,
// template literals and regexes are kept as they are, offsets and newlines
// too. When a lexer is unsure it keeps the text: a comment kept by mistake is
// a stale fact, a string blanked by mistake would hide a real reference.
//
// JS goes through js-tokens (MIT), HTML through parse5's spec tokenizer
// (MIT; its `entities` is BSD-2-Clause), CSS (and Unity's USS) through
// @csstools/css-tokenizer (MIT): maintained tokenizers that never fail on
// broken code. GDScript, Godot's text resources and the C family (C#,
// shaders) have no pure-JS maintained tokenizer (tree-sitter's are native
// addons), so the small lexers below cover exactly their comment and string
// forms.
import { tokenize, TokenType } from "@csstools/css-tokenizer";
import jsTokens from "js-tokens";
import { parse } from "parse5";

const blank = (text: string) => text.replace(/[^\n]/g, " ");

/** The text with the ranges [start, end) blanked. */
const blankRanges = (text: string, ranges: ReadonlyArray<readonly [number, number]>) => {
  let out = "";
  let at = 0;
  for (const [start, end] of [...ranges].toSorted((a, b) => a[0] - b[0])) {
    if (start < at) continue;
    out += text.slice(at, start) + blank(text.slice(start, end));
    at = end;
  }
  return out + text.slice(at);
};

const js = (text: string): string => {
  let out = "";
  for (const token of jsTokens(text))
    out +=
      token.type === "SingleLineComment" ||
      token.type === "MultiLineComment" ||
      token.type === "HashbangComment"
        ? blank(token.value)
        : token.value;
  return out;
};

const css = (text: string): string =>
  blankRanges(
    text,
    tokenize({ css: text })
      .filter((token) => token[0] === TokenType.Comment)
      .map((token) => [token[2], token[3] + 1] as const),
  );

type Html = {
  readonly nodeName: string;
  readonly childNodes?: ReadonlyArray<Html>;
  readonly content?: Html;
  readonly attrs?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly sourceCodeLocation?: { readonly startOffset: number; readonly endOffset: number } | null;
};

const html = (text: string): string => {
  const ranges: Array<readonly [number, number]> = [];
  const bodies: Array<{ readonly start: number; readonly end: number; readonly clean: string }> =
    [];
  const visit = (node: Html) => {
    const at = node.sourceCodeLocation;
    if (node.nodeName === "#comment" && at) ranges.push([at.startOffset, at.endOffset]);
    if (node.nodeName === "script" || node.nodeName === "style") {
      const body = node.childNodes?.[0]?.sourceCodeLocation;
      const type = node.attrs?.find((a) => a.name === "type")?.value ?? "";
      // An import map is JSON: it has no comments.
      if (body && !(node.nodeName === "script" && /importmap|json/i.test(type))) {
        const inner = text.slice(body.startOffset, body.endOffset);
        bodies.push({
          start: body.startOffset,
          end: body.endOffset,
          clean: node.nodeName === "style" ? css(inner) : js(inner),
        });
      }
    }
    for (const child of node.childNodes ?? []) visit(child);
    if (node.content !== undefined) visit(node.content);
  };
  visit(parse(text, { sourceCodeLocationInfo: true }) as unknown as Html);
  let out = blankRanges(text, ranges);
  for (const body of bodies) out = out.slice(0, body.start) + body.clean + out.slice(body.end);
  return out;
};

/** One-character-ahead lexer for the line-comment, block-comment and string forms a dialect has. */
const lexed = (
  text: string,
  dialect: {
    readonly line: ReadonlyArray<string>;
    readonly block: boolean;
    readonly strings: (at: number) => { readonly end: number } | null;
  },
): string => {
  const ranges: Array<readonly [number, number]> = [];
  let i = 0;
  while (i < text.length) {
    const string = dialect.strings(i);
    if (string !== null) {
      i = Math.max(string.end, i + 1);
      continue;
    }
    if (dialect.line.some((marker) => text.startsWith(marker, i))) {
      const end = text.indexOf("\n", i);
      ranges.push([i, end < 0 ? text.length : end]);
      i = end < 0 ? text.length : end;
      continue;
    }
    if (dialect.block && text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      // An unclosed block comment is the lexer unsure: the rest is kept.
      if (end < 0) break;
      ranges.push([i, end + 2]);
      i = end + 2;
      continue;
    }
    i += 1;
  }
  return blankRanges(text, ranges);
};

/** Where a quoted run that starts at `at` ends, or null when none starts there. */
const quoted = (text: string, at: number, quote: string, escapes: boolean, lines: boolean) => {
  let i = at + quote.length;
  while (i < text.length) {
    if (escapes && text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text.startsWith(quote, i)) return { end: i + quote.length };
    if (!lines && text[i] === "\n") return { end: i };
    i += 1;
  }
  return { end: text.length };
};

// GDScript: "…", '…', """…""", '''…''', a raw r"…", and the &"…" / ^"…" names.
const gdscript = (text: string) =>
  lexed(text, {
    line: ["#"],
    block: false,
    strings: (at) => {
      const raw =
        text[at] === "r" && /["']/.test(text[at + 1] ?? "") && !/\w/.test(text[at - 1] ?? "");
      const start =
        raw || ((text[at] === "&" || text[at] === "^") && /["']/.test(text[at + 1] ?? ""))
          ? at + 1
          : at;
      for (const quote of ['"""', "'''", '"', "'"])
        if (text.startsWith(quote, start))
          return quoted(text, start, quote, !raw, quote.length === 3);
      return null;
    },
  });

// Godot's text resources (.tscn, .tres, project.godot, .cfg): `;` comments,
// double-quoted strings that may span lines.
const godotResource = (text: string) =>
  lexed(text, {
    line: [";"],
    block: false,
    strings: (at) => (text[at] === '"' ? quoted(text, at, '"', true, true) : null),
  });

// C# and shaders: //, /* */, "…", '…', @"…" ("" escapes), $"…" and raw """…""".
// An interpolated string's holes are read as part of it: a comment inside a
// hole is kept, never a string blanked.
const cFamily = (text: string) =>
  lexed(text, {
    line: ["//"],
    block: true,
    strings: (at) => {
      let start = at;
      let verbatim = false;
      while (text[start] === "$" || text[start] === "@") {
        if (text[start] === "@") verbatim = true;
        start += 1;
      }
      if (start === at && text[at] !== '"' && text[at] !== "'") return null;
      if (text.startsWith('"""', start)) {
        let quotes = 0;
        while (text[start + quotes] === '"') quotes += 1;
        return quoted(text, start, '"'.repeat(quotes), false, true);
      }
      if (text[start] === "'" && start === at) return quoted(text, at, "'", true, false);
      if (text[start] !== '"') return null;
      if (verbatim) {
        let i = start + 1;
        while (i < text.length) {
          if (text[i] === '"' && text[i + 1] === '"') i += 2;
          else if (text[i] === '"') return { end: i + 1 };
          else i += 1;
        }
        return { end: text.length };
      }
      return quoted(text, start, '"', true, false);
    },
  });

/** The source with its comments blanked, by its kind; any other file as it is. */
export const codeOnly = (path: string, text: string): string => {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
    case "ts":
    case "mts":
      return js(text);
    case "html":
    case "htm":
    case "uxml":
      return html(text);
    case "css":
    case "uss":
      return css(text);
    case "gd":
      return gdscript(text);
    case "tscn":
    case "tres":
    case "godot":
    case "cfg":
      return godotResource(text);
    case "cs":
    case "gdshader":
    case "shader":
    case "hlsl":
    case "cginc":
      return cFamily(text);
    default:
      return text;
  }
};
