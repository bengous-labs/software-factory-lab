/** A backslash escape: GitHub shows the punctuation after it as text. */
const ESCAPED = /\\[!-/:-@[-`{-~]/u;

/** A fenced code block at column 0, to its closing fence or the end of the text. */
const BACKTICK_FENCE = /^(?<tick>`{3,})[^`\n]*\n[\s\S]*?(?:^\k<tick>`*[ \t]*$|(?![\s\S]))/u;

const TILDE_FENCE = /^(?<tilde>~{3,})[^\n]*\n[\s\S]*?(?:^\k<tilde>~*[ \t]*$|(?![\s\S]))/u;

/** A code span on one line: a run of backticks closed by a run of the same length. */
const CODE_SPAN = /(?<!`)(?<ticks>`+)(?!`)[^\n]*?(?<!`)\k<ticks>(?!`)/u;

/** The `<` that opens raw HTML in CommonMark: before a letter, `/`, `!` or `?`. */
const TAG_START = /<(?=[A-Za-z/!?])/u;

/**
 * What `escapeHtml` leaves as written, then the `<` it escapes. Code it does not recognize, such as a
 * fence indented in a list or a code span over two lines, gets its `<` escaped too: a stray `\` shows
 * in that code, where leaving it would let GitHub read raw HTML.
 */
const TOKEN = new RegExp(
  [ESCAPED, BACKTICK_FENCE, TILDE_FENCE, CODE_SPAN, TAG_START].map((pattern) => pattern.source).join("|"),
  "gmu",
);

/**
 * `text` with each `<` that GitHub would read as an HTML tag escaped as `\<`, outside code, so a
 * placeholder such as `<head>` shows as written. Markdown structure (`#`, `>`, `- `) stays as it is,
 * and escaping twice changes nothing.
 */
export function escapeHtml(text: string): string {
  return text.replaceAll(TOKEN, (token) => (token === "<" ? String.raw`\<` : token));
}

/** `text` with the `\<` outside code read back as `<`: what `escapeHtml` was given, when that held no `\<`. */
export function unescapeHtml(text: string): string {
  return text.replaceAll(TOKEN, (token) => (token === String.raw`\<` ? "<" : token));
}
