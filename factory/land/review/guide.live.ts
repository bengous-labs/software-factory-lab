/**
 * The guides of a review, read from the checkout of the Trunk: `REVIEW.md`, the root `AGENTS.md`, the
 * `AGENTS.md` of each directory under `factory/`, and the rules under `.claude/rules/`. Their text goes
 * into the reviewer's prompt, next to the job's token, so each is a regular file of that checkout: a link
 * could name any file the runner reads, the job's environment among them.
 */

import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";

/** The directory whose every `AGENTS.md` holds the design of the code beside it. */
const FACTORY = "factory";

const DIRECTORY_GUIDE = "AGENTS.md";

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

/** The files under `dir` of `root` that `keep` admits by name, each by its path from the root; a link is listed, and fails when it is read. */
function filesUnder(root: string, dir: string, keep: (name: string) => boolean): string[] {
  return readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => keep(entry.name) && !entry.isDirectory())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)));
}

/**
 * Every guide that sits beside the code of `root`: the `AGENTS.md` of each directory under `factory/`,
 * and every Markdown file under `.claude/rules/`, in the order of their paths; one reached through a link
 * fails the read.
 */
export function readRules(root: string): readonly GuideFile[] {
  return [
    ...filesUnder(root, FACTORY, (name) => name === DIRECTORY_GUIDE),
    ...filesUnder(root, RULES, (name) => name.endsWith(".md")),
  ]
    .toSorted()
    .map((path) => ({ path, text: readGuide(root, path) }));
}
