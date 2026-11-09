/** A backslash escape: GitHub shows the punctuation after it as text. */
const ESCAPED = /\\[!-/:-@[-`{-~]/u;

/** A fenced code block opened at column 0, to its closing fence, indented up to 3 spaces, or the end of the text. */
const BACKTICK_FENCE = /^(?<tick>`{3,})[^`\n]*\n[\s\S]*?(?:^ {0,3}\k<tick>`*[ \t]*$|(?![\s\S]))/u;

const TILDE_FENCE = /^(?<tilde>~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\k<tilde>~*[ \t]*$|(?![\s\S]))/u;

/** A code span on one line: a run of backticks closed by a run of the same length. */
const CODE_SPAN = /(?<!`)(?<ticks>`+)(?!`)[^\n]*?(?<!`)\k<ticks>(?!`)/u;

/** The `<` that opens raw HTML in CommonMark: before a letter, `/`, `!` or `?`. */
const TAG_START = /<(?=[A-Za-z/!?])/u;

/**
 * What `escapeHtml` leaves as written, then the `<` it escapes. Code it does not recognize, such as a
 * fence indented in a list or a code span over two lines, gets its `<` escaped too: a stray `\` shows
 * in that code, where leaving it would let GitHub read raw HTML.
 */
const TOKEN_SOURCE = [ESCAPED, BACKTICK_FENCE, TILDE_FENCE, CODE_SPAN, TAG_START]
  .map((pattern) => pattern.source)
  .join("|");

const PAIRED = new RegExp([ESCAPED, CODE_SPAN].map((pattern) => pattern.source).join("|"), "gmu");

const BLANK_LINE = /\n[ \t]*\n/gu;

/** Where the paragraph that holds `offset` starts: after the last blank line before it. */
function paragraphStart(text: string, offset: number): number {
  const blanks = [...text.slice(0, offset).matchAll(BLANK_LINE)];
  const last = blanks.at(-1);

  return last === undefined ? 0 : last.index + last[0].length;
}

/**
 * Whether a run of `length` backticks is left open in `before`. A code span can cross lines, so such a
 * run may pair with the one at `offset`, which then closes a span instead of opening one.
 */
function leftOpen(before: string, length: number): boolean {
  return before
    .replaceAll(PAIRED, "")
    .split(/[^`]+/u)
    .some((run) => run.length === length);
}

/** `text` with each token of `TOKEN_SOURCE` passed through `swap`, a code span that may close an earlier one read as text. */
function rewritten(text: string, swap: (token: string) => string): string {
  const token = new RegExp(TOKEN_SOURCE, "gmu");
  let out = "";
  let last = 0;

  for (let match = token.exec(text); match !== null; match = token.exec(text)) {
    const ticks = match.groups?.["ticks"];

    const asText =
      ticks !== undefined && leftOpen(text.slice(paragraphStart(text, match.index), match.index), ticks.length);

    const end = asText ? match.index + ticks.length : token.lastIndex;

    out += text.slice(last, match.index) + (asText ? text.slice(match.index, end) : swap(match[0]));
    last = end;
    token.lastIndex = end;
  }

  return out + text.slice(last);
}

/**
 * `text` with each `<` that GitHub would read as an HTML tag escaped as `\<`, outside code, so a
 * placeholder such as `<head>` shows as written. Markdown structure (`#`, `>`, `- `) stays as it is,
 * and escaping twice changes nothing.
 */
export function escapeHtml(text: string): string {
  return rewritten(text, (token) => (token === "<" ? String.raw`\<` : token));
}

/** `text` with the `\<` outside code read back as `<`: what `escapeHtml` was given, when that held no `\<`. */
export function unescapeHtml(text: string): string {
  return rewritten(text, (token) => (token === String.raw`\<` ? "<" : token));
}
