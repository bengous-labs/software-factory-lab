/** A backslash escape: GitHub shows the punctuation after it as text. */
const ESCAPED = /\\[!-/:-@[-`{-~]/u;

/** A closed fenced code block, its fences at the start of a line: an unclosed one is no code. */
const BACKTICK_FENCE = /(?<=^|\n)(?<tick>`{3,})[^`\n]*\n[\s\S]*?(?<=\n) {0,3}\k<tick>`*[ \t]*(?=\n|$)/u;

const TILDE_FENCE = /(?<=^|\n)(?<tilde>~{3,})(?!~)[^\n]*\n[\s\S]*?(?<=\n) {0,3}\k<tilde>~*[ \t]*(?=\n|$)/u;

/**
 * A word GitHub's extended autolink may take, from `www.` or `scheme://` to the next ASCII space: once
 * its `<` are written `&lt;`, the link runs through them, backticks and brackets included. Its brackets
 * stay, so the link keeps its target; its `<` and backticks are escaped, so a code span cannot open
 * inside it, and a word GitHub does not link pairs with nothing. `\t-\r` is the tab, the line feed, the
 * vertical tab, the form feed and the carriage return, as a range: the mutation job's regex mutator turns
 * a written `\v` into `\V`, which no Unicode pattern parses, and the module stops loading.
 */
const AUTOLINK = /(?:[Ww]{3}\.|[A-Za-z][A-Za-z\d+.-]*:\/\/)[^ \t-\r]*/u;

/** A code span on one line with no `|`: a table cell would split it, and GitHub would read its content as text. */
const CODE_SPAN = /(?<!`)(?<ticks>`+)(?!`)[^\n|]*?(?<!`)\k<ticks>(?!`)/u;

/** A run of backticks no span closes: escaped, so it cannot pair with a backtick outside the text. */
const OPEN_RUN = /`+/u;

/** A tilde fence no fence closes, its first `~` escaped, so it cannot swallow what follows the text. */
const OPEN_TILDE_FENCE = /(?<=^|\n) {0,3}~(?=~~)/u;

/**
 * What can open HTML or take a backtick from a code span: `<`, a link's `[` or `]`, math's `$`. A `<`
 * becomes `&lt;`, not `\<`: an extended autolink that stops at the `<` would take the `\` and leave it raw.
 */
const OPENER = /[[\]$<]/u;

const ESCAPED_ANGLE = /&lt;/u;

/**
 * What the escaper reads, first match wins. Only code it is sure of is left as written: anything else
 * that could open HTML, or take a backtick from code, is escaped.
 */
const TOKEN = new RegExp(
  [ESCAPED, ESCAPED_ANGLE, BACKTICK_FENCE, TILDE_FENCE, AUTOLINK, CODE_SPAN, OPEN_RUN, OPEN_TILDE_FENCE, OPENER]
    .map((pattern) => pattern.source)
    .join("|"),
  "gu",
);

const AUTOLINK_WORD = new RegExp(`^${AUTOLINK.source}$`, "u");

/** In an autolink's word, a `<` (written or escaped) as `&lt;`, a backtick as `` \` ``, other escapes as they are. */
function escapedInLink(part: string): string {
  if (part === "`") {
    return "\\`";
  }

  return part === "<" || part === String.raw`\<` ? "&lt;" : part;
}

/** A token as `escapeHtml` writes it: an opener escaped, an autolink's `<` and backticks escaped, code and escapes as they are. */
function escapedToken(token: string): string {
  if (token === "<" || token === String.raw`\<`) {
    return "&lt;";
  }

  if (AUTOLINK_WORD.test(token)) {
    return token.replaceAll(/\\[!-/:-@[-`{-~]|[`<]/gu, escapedInLink);
  }

  return /^(?: {0,3}~|`+|[[\]$])$/u.test(token) ? token.replaceAll(/[`~[\]$]/gu, String.raw`\$&`) : token;
}

/**
 * `text`, a whole Markdown body or a block that starts a line, escaped outside code so GitHub reads no
 * HTML in it: each `<`, each backtick no span closes, each `[` and `]`, and each `$`, but a URL GitHub
 * links keeps its brackets. A placeholder such as `<head>` then shows as written, and the text cannot
 * open code that swallows what follows it. A link the text holds shows as text. Other Markdown (`#`,
 * `>`, `- `, emphasis) stays as it is, and escaping twice changes nothing.
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

/** `token` read back: `&lt;` as `<`, an escaped backtick, `~`, `$`, `[` or `]` without its `\`. */
function unescapedToken(token: string): string {
  if (token === "&lt;") {
    return "<";
  }

  return AUTOLINK_WORD.test(token)
    ? token.replaceAll("\\`", "`").replaceAll("&lt;", "<")
    : token.replace(/^\\(?=[`~$[\]]$)/u, "");
}

/**
 * `text` with what `escapeHtml` escaped outside code read back. It gives back what `escapeHtml` was
 * given, when that held none of the escapes `escapeHtml` writes (`\<`, `&lt;`, and a `\` before a
 * backtick, `~`, `$`, `[` or `]`) and no carriage return: a `\<` or a `&lt;` the text wrote reads back as
 * `<`, and the other escapes lose their `\`.
 */
export function unescapeHtml(text: string): string {
  return text.replaceAll(TOKEN, unescapedToken);
}
