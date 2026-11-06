/**
 * The Routing rules: what sends a change to the deepest review whatever a model says of it, and who
 * lands it. The GitHub workflows, the session hooks and settings, the task file's format and the build
 * config always go to the owner. So do the Land loop's own scripts, like any other risky path: the
 * judges read only the diff, so no route lands a risky path without the owner.
 */

import type { RoutingAnswer } from "../merge-bot/decide.ts";

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

export interface RoutingInput {
  readonly paths: readonly string[];
  readonly lines: number;
  readonly messages: readonly string[];
}

const toOwner = (reason: string): RoutingAnswer => ({ land: "owner", review: "deep", secondRound: true, reason, model: null, needsFable: false });

/** The Routing rules' answer, or null when the change is the model's to judge. */
export function routingRulesOf({ paths, lines, messages }: RoutingInput): RoutingAnswer | null {
  if (paths.length === 0) return toOwner("the change touches no file");

  const risky = paths.filter((path) => RISKY.some((glob) => glob.match(path)));

  if (risky.length > 0) return toOwner(`touches a risky path: ${risky.slice(0, 3).join(", ")}`);

  const breaking = messages.find((message) => BREAKING.test(message));

  if (breaking !== undefined) return toOwner(`a breaking commit: ${breaking.split("\n")[0]}`);

  if (lines > LINE_CAP) return toOwner(`${lines} lines changed, past the ${LINE_CAP}-line cap`);

  return null;
}
