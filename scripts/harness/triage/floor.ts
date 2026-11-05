/**
 * The triage floor: what sends a change to the deepest review whatever a model says of it, and who
 * lands it. The workflows, the session hooks and settings, the task file's format and the build
 * config always go to the owner. A change whose only risky paths are the harness's own scripts may
 * land without the owner once an independent Fable review answers OK on top of the deep review.
 */

import type { Triage } from "../conductor/decide.ts";

export const HARNESS = ["scripts/harness/**"].map((glob) => new Bun.Glob(glob));

export const RISKY = [
  ".github/**",
  "scripts/**",
  ".claude/**",
  "REVIEW.md",
  "AGENTS.md",
  "CLAUDE.md",
  "app/src/store/**",
  "package.json",
  "bun.lock",
  "mise.toml",
  "tsconfig.json",
].map((glob) => new Bun.Glob(glob));

export const LINE_CAP = 400;

const BREAKING = /^\w+(\([^)]*\))?!:|BREAKING CHANGE/mu;

export interface FloorInput {
  readonly paths: readonly string[];
  readonly lines: number;
  readonly messages: readonly string[];
}

const human = (reason: string): Triage => ({ land: "human", review: "deep", secondRound: true, reason, model: null, needsFable: false });

/** The floor's answer, or null when the change is the model's to judge. */
export function floorOf({ paths, lines, messages }: FloorInput): Triage | null {
  if (paths.length === 0) return human("the change touches no file");

  const risky = paths.filter((path) => RISKY.some((glob) => glob.match(path)));
  const ownerOnly = risky.filter((path) => !HARNESS.some((glob) => glob.match(path)));

  if (ownerOnly.length > 0) return human(`touches a risky path: ${ownerOnly.slice(0, 3).join(", ")}`);

  const breaking = messages.find((message) => BREAKING.test(message));

  if (breaking !== undefined) return human(`a breaking commit: ${breaking.split("\n")[0]}`);

  if (lines > LINE_CAP) return human(`${lines} lines changed, past the ${LINE_CAP}-line cap`);

  if (risky.length > 0) {
    return {
      land: "auto",
      review: "deep",
      secondRound: true,
      reason: `touches the harness only: ${risky.slice(0, 3).join(", ")}; lands after a deep review and a Fable OK`,
      model: null,
      needsFable: true,
    };
  }

  return null;
}
