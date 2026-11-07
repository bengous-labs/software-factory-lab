/**
 * The Routing rules: what sets a change's Land route and Review depth whatever a model says of it, under
 * the routing policy of the factory config. A path of `ownerPaths`, or the factory config itself, sends
 * the change to the Owner. A path of `deepReviewPaths` gets a deep Code review and lands without the
 * Owner once CI is green and no Important is open. A change that also touches any other path goes to the
 * Owner when one of its commits is breaking or it is past `lineCap`; a change of other paths only is
 * otherwise the Routing judge's.
 */

import { FACTORY_CONFIG_PATH } from "../factory-config.ts";
import type { RoutingPolicy } from "../factory-config.ts";
import type { RoutingAnswer } from "../merge-bot/decide.ts";

const BREAKING = /^\w+(\([^)]*\))?!:|BREAKING CHANGE/mu;

export interface RoutingInput {
  readonly paths: readonly string[];
  readonly lines: number;
  readonly messages: readonly string[];
}

const toOwner = (reason: string): RoutingAnswer => ({
  land: "owner",
  review: "deep",
  secondRound: true,
  reason,
  model: null,
  needsFable: false,
});

function matching(globs: readonly string[], paths: readonly string[]): readonly string[] {
  const compiled = globs.map((glob) => new Bun.Glob(glob));

  return paths.filter((path) => compiled.some((glob) => glob.match(path)));
}

const listed = (paths: readonly string[]): string => paths.slice(0, 3).join(", ");

/** The Routing rules' answer, or null when the change is the model's to judge. */
export function routingRulesOf(policy: RoutingPolicy, { paths, lines, messages }: RoutingInput): RoutingAnswer | null {
  if (paths.length === 0) {
    return toOwner("the change touches no file");
  }

  const owner = matching([FACTORY_CONFIG_PATH, ...policy.ownerPaths], paths);

  if (owner.length > 0) {
    return toOwner(`touches a path the Owner lands: ${listed(owner)}`);
  }

  const deep = matching(policy.deepReviewPaths, paths);

  if (deep.length < paths.length) {
    const breaking = messages.find((message) => BREAKING.test(message));

    if (breaking !== undefined) {
      return toOwner(`a breaking commit: ${breaking.split("\n")[0]}`);
    }

    if (lines > policy.lineCap) {
      return toOwner(`${lines} lines changed, past the ${policy.lineCap}-line cap`);
    }
  }

  if (deep.length > 0) {
    return {
      land: "auto",
      review: "deep",
      secondRound: true,
      reason: `touches a path a deep review reads: ${listed(deep)}; lands once CI is green and no Important is open`,
      model: null,
      needsFable: false,
    };
  }

  return null;
}
