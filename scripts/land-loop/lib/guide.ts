/**
 * The guides of a review, read from the checkout of `dev`: `REVIEW.md`, `AGENTS.md` and the rules under
 * `.claude/rules/`. Their text goes into the reviewer's prompt, next to the job's token, so each is a
 * regular file of that checkout: a link could name any file the runner reads, the job's environment
 * among them.
 */

import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";

const RULES = ".claude/rules";

/** A guide file: its path from the checkout's root, and its text. */
interface GuideFile {
  readonly path: string;
  readonly text: string;
}

/**
 * The text of the guide at `path` under `root`. A link is refused, the file's own or a directory's on the
 * way to it, and so is anything but a regular file.
 */
export function readGuide(root: string, path: string): string {
  const file = join(realpathSync(root), path);

  if (realpathSync(file) !== file || !lstatSync(file).isFile()) {
    throw new Error(`${path} is not a regular file of the checkout: a guide of the review is never a link`);
  }

  return readFileSync(file, "utf8");
}

/** Every Markdown file under `.claude/rules/` of `root`, in the order of their paths; one reached through a link fails the read. */
export function readRules(root: string): readonly GuideFile[] {
  return readdirSync(join(root, RULES), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.name.endsWith(".md") && !entry.isDirectory())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .toSorted()
    .map((path) => ({ path, text: readGuide(root, path) }));
}
