/** A backslash escape: GitHub shows the punctuation after it as text. */
const ESCAPED = /\\[!-/:-@[-`{-~]/u;

/** A closed fenced code block, its fences at the start of a line: an unclosed one is no code. */
const BACKTICK_FENCE = /(?<=^|\n)(?<tick>`{3,})[^`\n]*\n[\s\S]*?(?<=\n) {0,3}\k<tick>`*[ \t]*(?=\n|$)/u;

const TILDE_FENCE = /(?<=^|\n)(?<tilde>~{3,})(?!~)[^\n]*\n[\s\S]*?(?<=\n) {0,3}\k<tilde>~*[ \t]*(?=\n|$)/u;

/**
 * A code span on one line with no `|`: a table cell would split it, and GitHub would read its content
 * as text. It opens neither in a word after `www.` nor after a `:`: GitHub's extended autolink
 * (`www.`, `https://`) runs to the next ASCII space, past any other, and would take its opening backtick.
 */
const CODE_SPAN = /(?<!`)(?=`)(?<!(?:[Ww]{3}\.|:)[^ \t\n\v\f\r]*)(?<ticks>`+)(?!`)[^\n|]*?(?<!`)\k<ticks>(?!`)/u;

/** A run of backticks no span closes: escaped, so it cannot pair with a backtick outside the text. */
const OPEN_RUN = /`+/u;

/** A tilde fence no fence closes, its first `~` escaped, so it cannot swallow what follows the text. */
const OPEN_TILDE_FENCE = /(?<=^|\n) {0,3}~(?=~~)/u;

/**
 * What can take a backtick before a code span closes it, so the span's `<` would be read as HTML: a
 * link, image, reference or definition (any `[` or `]`), and GitHub's math (`$`). Each is escaped, so
 * it opens nothing.
 */
const BRACKET = /[[\]]/u;

const MATH = /\$/u;

/**
 * Every `<`: raw HTML and autolinks start with one, and an autolink can take a backtick too. It becomes
 * `&lt;`, not `\<`: an extended autolink that stops at the `<` would take the `\` and leave the `<` raw.
 */
const ANGLE = /</u;

const ESCAPED_ANGLE = /&lt;/u;

/**
 * What the escaper reads, first match wins. Only code it is sure of is left as written: anything else
 * that could open HTML, or take a backtick from code, is escaped.
 */
const TOKEN = new RegExp(
  [ESCAPED, ESCAPED_ANGLE, BACKTICK_FENCE, TILDE_FENCE, CODE_SPAN, OPEN_RUN, OPEN_TILDE_FENCE, BRACKET, MATH, ANGLE]
    .map((pattern) => pattern.source)
    .join("|"),
  "gu",
);

const ESCAPED_SINGLES = new Map([
  ["<", "&lt;"],
  [String.raw`\<`, "&lt;"],
  ["$", String.raw`\$`],
  ["[", String.raw`\[`],
  ["]", String.raw`\]`],
]);

/** A token as `escapeHtml` writes it: an opener escaped, code and escapes as they are. */
function escapedToken(token: string): string {
  const single = ESCAPED_SINGLES.get(token);

  if (single !== undefined) {
    return single;
  }

  if (/^ {0,3}~$/u.test(token)) {
    return token.replace("~", String.raw`\~`);
  }

  return /^`+$/u.test(token) ? token.replaceAll("`", String.raw`\``) : token;
}

/**
 * `text`, a whole Markdown body or a block that starts a line, escaped outside code so GitHub reads no
 * HTML in it: each `<`, each backtick no span closes, each `[` and `]`, and each `$`. A
 * placeholder such as `<head>` then shows as written, and the text cannot open code that swallows what
 * follows it. A link the text holds shows as text. Other Markdown (`#`, `>`, `- `, emphasis) stays as
 * it is, and escaping twice changes nothing.
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

const UNESCAPED = new Map([
  ["&lt;", "<"],
  [String.raw`\``, "`"],
  [String.raw`\~`, "~"],
  [String.raw`\$`, "$"],
  [String.raw`\[`, "["],
  [String.raw`\]`, "]"],
]);

/**
 * `text` with what `escapeHtml` escaped outside code read back: `&lt;` as `<`, and a backtick, `~`, `$`,
 * `[` or `]` without its `\`. It gives back what `escapeHtml` was given, when that held none of these
 * escapes itself (a `&lt;` the text wrote reads back as `<`) and no carriage return.
 */
export function unescapeHtml(text: string): string {
  return text.replaceAll(TOKEN, (token) => UNESCAPED.get(token) ?? token);
}
