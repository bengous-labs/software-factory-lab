/** A backslash escape: GitHub shows the punctuation after it as text. */
const ESCAPED = /\\[!-/:-@[-`{-~]/u;

/** A closed fenced code block, its fences at the start of a line: an unclosed one is no code. */
const BACKTICK_FENCE = /(?<=^|\n)(?<tick>`{3,})[^`\n]*\n[\s\S]*?(?<=\n) {0,3}\k<tick>`*[ \t]*(?=\n|$)/u;

const TILDE_FENCE = /(?<=^|\n)(?<tilde>~{3,})(?!~)[^\n]*\n[\s\S]*?(?<=\n) {0,3}\k<tilde>~*[ \t]*(?=\n|$)/u;

/** A code span on one line with no `|`: a table cell would split it, and GitHub would read its content as text. */
const CODE_SPAN = /(?<!`)(?<ticks>`+)(?!`)[^\n|]*?(?<!`)\k<ticks>(?!`)/u;

/** A run of backticks no span closes: escaped, so it cannot pair with a backtick outside the text. */
const OPEN_RUN = /`+/u;

/** A tilde fence no fence closes, its first `~` escaped, so it cannot swallow what follows the text. */
const OPEN_TILDE_FENCE = /(?<=^|\n) {0,3}~(?=~~)/u;

/** The `<` that opens raw HTML in CommonMark: before a letter, `/`, `!` or `?`. */
const TAG_START = /<(?=[A-Za-z/!?])/u;

/**
 * What the escaper reads, first match wins. Only code it is sure of is left as written: anything else
 * gets its `<` and its backticks escaped, so a miss shows a stray `\`, never raw HTML.
 */
const TOKEN = new RegExp(
  [ESCAPED, BACKTICK_FENCE, TILDE_FENCE, CODE_SPAN, OPEN_RUN, OPEN_TILDE_FENCE, TAG_START]
    .map((pattern) => pattern.source)
    .join("|"),
  "gu",
);

/** A token as `escapeHtml` writes it: a tag start, an open run or an open fence escaped, code and escapes as they are. */
function escapedToken(token: string): string {
  if (token === "<") {
    return String.raw`\<`;
  }

  if (/^ {0,3}~$/u.test(token)) {
    return token.replace("~", String.raw`\~`);
  }

  return /^`+$/u.test(token) ? token.replaceAll("`", String.raw`\``) : token;
}

/**
 * `text`, a whole Markdown body or a block that starts a line, with each `<` that GitHub would read
 * as an HTML tag escaped as `\<` and each backtick that closes no span escaped as `` \` ``, outside
 * code. A placeholder such as `<head>` then shows as written, and the text cannot open code that
 * swallows what follows it. Markdown structure (`#`, `>`, `- `) stays as it is, and escaping twice
 * changes nothing.
 */
export function escapeHtml(text: string): string {
  return text.replaceAll(/\r\n?/gu, "\n").replaceAll(TOKEN, escapedToken);
}

/** `text` for the middle of a line: on one line, so it opens no block, then escaped as `escapeHtml` does. */
export function escapeInline(text: string): string {
  return escapeHtml(text.replaceAll(/\s+/gu, " ").trim());
}

/** `text` in a code span, on one line, its fence longer than any backtick run it holds. */
export function codeSpan(text: string): string {
  const inline = text.replaceAll(/\s+/gu, " ").trim();
  const longest = Math.max(0, ...(inline.match(/`+/gu) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = inline.startsWith("`") || inline.endsWith("`") ? " " : "";

  return `${fence}${pad}${inline}${pad}${fence}`;
}

const UNESCAPED: ReadonlySet<string> = new Set([String.raw`\<`, String.raw`\``, String.raw`\~`]);

/**
 * `text` with what `escapeHtml` escaped outside code read back: `\<`, `` \` `` and `\~` without their
 * `\`. It gives back what `escapeHtml` was given, when that held no `\` before a `<`, a backtick or a `~`.
 */
export function unescapeHtml(text: string): string {
  return text.replaceAll(TOKEN, (token) => (UNESCAPED.has(token) ? token.slice(1) : token));
}
