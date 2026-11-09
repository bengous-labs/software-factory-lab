import { describe, expect, test } from "bun:test";

import * as fc from "fast-check";

import { codeSpan, escapeHtml, escapeInline, unescapeHtml } from "./markdown.ts";

const NBSP = String.fromCodePoint(0xa0);

/** GitHub's extensions that can take a backtick from a code span: autolinks and math. */
const GITHUB = { autolinks: true, latexMath: true };

/** Whether Markdown `text` holds raw HTML: its render changes when raw HTML is turned off. */
const hasRawHtml = (text: string): boolean =>
  Bun.markdown.html(text, GITHUB) !== Bun.markdown.html(text, { ...GITHUB, noHtmlSpans: true, noHtmlBlocks: true });

const markdownText = fc.string({
  unit: fc.constantFrom(
    "<",
    ">",
    "`",
    "``",
    "```",
    "~",
    "~~~",
    "~~~~",
    "\\",
    "!",
    "/",
    ":",
    "|",
    "| - |",
    "-",
    "- ",
    "> ",
    "1. ",
    "#",
    "*",
    "a",
    " ",
    "\n",
    "\n  ",
    "\n   ",
    "\n    ",
    "\n\n",
    "\r",
    "\u2028",
    "<b>",
    "<1",
    "&",
    "&lt;",
    "[",
    "]",
    "(",
    ")",
    "](",
    "]:",
    "![",
    "$",
    "'",
    "@",
    "1",
    "_",
    ".",
    "www.",
    "http://",
  ),
  maxLength: 50,
});

/** A review comment as `commentOf` assembles it, then the marker it ends with. */
const commentOf = (summary: string, place: string, scenario: string): string =>
  `**Important**: ${escapeInline(summary)}\nAt ${codeSpan(place)}, outside this diff.\n\n${escapeHtml(scenario)}\n\n<!-- m -->`;

describe("escapeHtml", () => {
  test.each([
    ["review-<head>.json", String.raw`review-&lt;head>.json`],
    [
      "reads '<code counts>; security: <security counts>.'",
      String.raw`reads '&lt;code counts>; security: &lt;security counts>.'`,
    ],
    ["a <!-- note --> b", String.raw`a &lt;!-- note --> b`],
    ["closes </x> and <?php", String.raw`closes &lt;/x> and &lt;?php`],
    ["see <https://example.com>", String.raw`see &lt;https://example.com>`],
    ["a < b and b > c", String.raw`a &lt; b and b > c`],
    ["[doc](https://x) and ![img](y)", String.raw`[doc]\(https://x) and ![img]\(y)`],
    ["[x]: /u and $a$", String.raw`[x]\: /u and \$a\$`],
    [String.raw`review-&lt;head>.json`, String.raw`review-&lt;head>.json`],
  ])("%j becomes %j", (text, escaped) => {
    expect(escapeHtml(text)).toBe(escaped);
  });

  test.each([
    "in `review-<head>.json` code",
    "in ``a `<x>` b`` code",
    "```ts\nconst x: Array<string> = [];\n```",
    "~~~\n<div>\n~~~",
    "```\n<x>\n   ```",
  ])("leaves the code of %j as written", (text) => {
    expect(escapeHtml(text)).toBe(text);
  });

  test.each([
    ["an unclosed fence is no code", "```\n<div>", `${String.raw`\`\`\``}\n${String.raw`&lt;div>`}`],
    ["an unclosed tilde fence is no code", "~~~\n<x>", `${String.raw`\~~~`}\n${String.raw`&lt;x>`}`],
    ["a shorter fence does not close a longer one", "~~~~\n  ~~~\n<x>", "\\~~~~\n  \\~~~\n&lt;x>"],
    ["a backtick in the info string opens no fence", "``` a`b\n<x>\n```", "\\`\\`\\` a\\`b\n&lt;x>\n\\`\\`\\`"],
    ["an unclosed backtick is escaped", "unclosed `review-<head>.json", "unclosed \\`review-&lt;head>.json"],
    ["a code span stops at the end of the line", "`a\n<x> b`", "\\`a\n&lt;x> b\\`"],
    ["a run of another length left open is escaped", "``a\n`b`` <b> `", "\\`\\`a\n`b`` <b> `"],
    ["a span with a pipe is no code, as in a table cell", "| `<a | b>` |", "| \\`&lt;a | b>\\` |"],
    [
      "a fence indented in a list item is escaped",
      "- a\n  ```\n  <x>\n  ```",
      "- a\n  \\`\\`\\`\n  &lt;x>\n  \\`\\`\\`",
    ],
    ["a closing fence indented up to 3 spaces closes the block", "```\n<x>\n   ```\n<b>", "```\n<x>\n   ```\n&lt;b>"],
    ["a link cannot take the backtick of a span", "[a](`) <b>x</b> `", "[a]\\(`) <b>x</b> `"],
    ["an email autolink cannot take it", "<1`@a.b> <!-- hide --> `", "&lt;1`@a.b> <!-- hide --> `"],
    ["an extended autolink cannot take it", "see www.x.com` <b>hi</b> `", "see www.x.com\\` &lt;b>hi&lt;/b> \\`"],
    ["nor a URL one", "https://x.io/a` <!-- hide --> `", "https://x.io/a\\` &lt;!-- hide --> \\`"],
    ["a span after a space stays code", "see www.x.com `<b>`", "see www.x.com `<b>`"],
    [
      String.raw`an autolink cannot take the \ of a \< the text wrote`,
      String.raw`see www.x.com\<img src=x>`,
      "see www.x.com&lt;img src=x>",
    ],
    [
      "an autolink runs past a no-break space",
      `see www.x.com${NBSP}\`<img>\` y`,
      String.raw`see www.x.com${NBSP}\`&lt;img>\` y`,
    ],
    ["math cannot take it", "$a`$ <b> `", "\\$a`$ <b> `"],
    ["U+2028 starts no line", "a \u2028```\n<b>\n```", "a \u2028\\`\\`\\`\n&lt;b>\n\\`\\`\\`"],
    ["a carriage return ends a line", "x\r```\r<b>\r```", "x\n```\n<b>\n```"],
  ])("%s", (_, text, escaped) => {
    expect(escapeHtml(text)).toBe(escaped);
  });

  test("the escaped text holds no raw HTML", () => {
    fc.assert(fc.property(markdownText, (text) => !hasRawHtml(escapeHtml(text))));
  });

  test("a comment assembled from escaped parts holds no raw HTML, and its marker stays a comment", () => {
    fc.assert(
      fc.property(markdownText, markdownText, markdownText, (summary, place, scenario) => {
        const comment = commentOf(summary, place, scenario);

        return (
          !hasRawHtml(comment.replace("<!-- m -->", "")) &&
          Bun.markdown.html(comment, GITHUB).trimEnd().endsWith("<!-- m -->")
        );
      }),
    );
  });

  test("escaping twice changes nothing", () => {
    fc.assert(fc.property(markdownText, (text) => escapeHtml(escapeHtml(text)) === escapeHtml(text)));
  });
});

describe("escapeInline", () => {
  test("puts the text on one line, so a fence or an HTML block cannot start in it", () => {
    expect(escapeInline("```\n<details>\n```")).toBe("``` <details> ```");
    expect(escapeInline(" two\n  lines <b> ")).toBe(String.raw`two lines &lt;b>`);
  });

  test("fragments joined on one line hold no raw HTML", () => {
    fc.assert(
      fc.property(
        fc.array(markdownText, { maxLength: 3 }),
        (parts) => !hasRawHtml(`- ${parts.map((part) => escapeInline(part)).join(": ")} | Author: x`),
      ),
    );
  });
});

describe("codeSpan", () => {
  test("fences the text with one more backtick than its longest run, padded when it starts or ends with one", () => {
    expect(codeSpan("a.ts:3")).toBe("`a.ts:3`");
    expect(codeSpan("x` <b> `y")).toBe("``x` <b> `y``");
    expect(codeSpan("`a`")).toBe("`` `a` ``");
    expect(codeSpan("a\n<details>")).toBe("`a <details>`");
  });
});

describe("unescapeHtml", () => {
  test("reads back the text escapeHtml was given", () => {
    fc.assert(
      fc.property(
        markdownText.filter((text) => !/\\[<`~$]|\]\\[(:]|&lt;/u.test(text) && !text.includes("\r")),
        (text) => unescapeHtml(escapeHtml(text)) === text,
      ),
    );
  });

  test("leaves code as written", () => {
    expect(unescapeHtml(`${String.raw`\`a&lt;b\` and &lt;c> in `}\`&lt;d>\``)).toBe("`a<b` and <c> in `&lt;d>`");
  });
});
