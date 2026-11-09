import { describe, expect, test } from "bun:test";

import * as fc from "fast-check";

import { escapeHtml, unescapeHtml } from "./markdown.ts";

/** Whether Markdown `text` holds raw HTML: its render changes when raw HTML is turned off. */
const hasRawHtml = (text: string): boolean =>
  Bun.markdown.html(text) !== Bun.markdown.html(text, { noHtmlSpans: true, noHtmlBlocks: true });

const markdownText = fc.string({
  unit: fc.constantFrom(
    "<",
    ">",
    "`",
    "\\",
    "~",
    "!",
    "?",
    "/",
    ":",
    "-",
    "#",
    "a",
    "h",
    " ",
    "\n",
    "``",
    "```",
    "~~~",
    "\n  ",
    "\n   ",
    "\n    ",
    "\n\n",
    "<b>",
  ),
  maxLength: 40,
});

describe("escapeHtml", () => {
  test.each([
    ["review-<head>.json", String.raw`review-\<head>.json`],
    [
      "reads '<code counts>; security: <security counts>.'",
      String.raw`reads '\<code counts>; security: \<security counts>.'`,
    ],
    ["a <!-- note --> b", String.raw`a \<!-- note --> b`],
    ["closes </x> and <?php", String.raw`closes \</x> and \<?php`],
    ["see <https://example.com>", String.raw`see \<https://example.com>`],
    ["a < b and b > c", "a < b and b > c"],
    [String.raw`review-\<head>.json`, String.raw`review-\<head>.json`],
  ])("%j becomes %j", (text, escaped) => {
    expect(escapeHtml(text)).toBe(escaped);
  });

  test.each([
    "in `review-<head>.json` code",
    "in ``a `<x>` b`` code",
    "```ts\nconst x: Array<string> = [];\n```",
    "~~~\n<div>\n~~~",
    "```\n<div> never closed",
  ])("leaves the code of %j as written", (text) => {
    expect(escapeHtml(text)).toBe(text);
  });

  test.each([
    ["a backtick in the info string opens no fence", "``` a`b\n<x>\n```", "``` a`b\n\\<x>\n```"],
    ["an unclosed backtick is text", "unclosed `review-<head>.json", "unclosed `review-\\<head>.json"],
    ["a code span stops at the end of the line", "`a\n<x> b`", "`a\n\\<x> b`"],
    ["a span that may close a run left open above is text", "`\n`<b>`", "`\n`\\<b>`"],
    ["a blank line closes the paragraph and its open runs", "`\n\n`<b>`", "`\n\n`<b>`"],
    ["a closing fence indented up to 3 spaces closes the block", "```\n<x>\n   ```\n<b>", "```\n<x>\n   ```\n\\<b>"],
    ["a fence indented in a list item is escaped", "- a\n  ```\n  <x>\n  ```", "- a\n  ```\n  \\<x>\n  ```"],
  ])("%s", (_, text, escaped) => {
    expect(escapeHtml(text)).toBe(escaped);
  });

  test("the escaped text holds no raw HTML", () => {
    fc.assert(fc.property(markdownText, (text) => !hasRawHtml(escapeHtml(text))));
  });

  test("escaping twice changes nothing", () => {
    fc.assert(fc.property(markdownText, (text) => escapeHtml(escapeHtml(text)) === escapeHtml(text)));
  });
});

describe("unescapeHtml", () => {
  test("reads back the text escapeHtml was given", () => {
    fc.assert(
      fc.property(
        markdownText.filter((text) => !text.includes(String.raw`\<`)),
        (text) => unescapeHtml(escapeHtml(text)) === text,
      ),
    );
  });

  test("leaves a `\\<` in code as written", () => {
    expect(unescapeHtml("`a\\<b` and \\<c>")).toBe("`a\\<b` and <c>");
  });
});
