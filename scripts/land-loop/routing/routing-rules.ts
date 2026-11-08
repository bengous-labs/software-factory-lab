/**
 * The Routing rules: what sets a change's Land route and Review depth whatever a model says of it, under
 * the routing policy of the factory config. A path of `ownerPaths`, or the factory config itself, sends
 * the change to the Owner. A path of `factoryPaths` or `deepReviewPaths` gets a deep Code review and
 * lands without the Owner once CI is green and no Important is open. A change that touches a path
 * outside `factoryPaths` goes to the Owner when one of its commits is breaking or it is past `lineCap`.
 * The Routing judge answers for the paths no rule names, and may raise a ruled change to the Owner.
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

/**
 * What the Routing rules make of a change: `ruled`, their answer stands; `judged`, the Routing judge
 * answers; `ruled-then-judged`, their answer stands unless the judge, asked about `judgedPaths`, the
 * paths no rule names, sends the change to the Owner.
 */
export type RulesVerdict =
  | { readonly kind: "ruled"; readonly answer: RoutingAnswer }
  | { readonly kind: "judged" }
  | { readonly kind: "ruled-then-judged"; readonly answer: RoutingAnswer; readonly judgedPaths: readonly string[] };

const toOwner = (reason: string): RulesVerdict => ({
  kind: "ruled",
  answer: { land: "owner", review: "deep", secondRound: true, reason, model: null },
});

function matching(globs: readonly string[], paths: readonly string[]): readonly string[] {
  const compiled = globs.map((glob) => new Bun.Glob(glob));

  return paths.filter((path) => compiled.some((glob) => glob.match(path)));
}

const listed = (paths: readonly string[]): string => paths.slice(0, 3).join(", ");

export function routingRulesOf(policy: RoutingPolicy, { paths, lines, messages }: RoutingInput): RulesVerdict {
  if (paths.length === 0) {
    return toOwner("the change touches no file");
  }

  const owner = matching([FACTORY_CONFIG_PATH, ...policy.ownerPaths], paths);

  if (owner.length > 0) {
    return toOwner(`touches a path the Owner lands: ${listed(owner)}`);
  }

  const factory = matching(policy.factoryPaths, paths);

  if (factory.length < paths.length) {
    const breaking = messages.find((message) => BREAKING.test(message));

    if (breaking !== undefined) {
      return toOwner(`a breaking commit: ${breaking.split("\n")[0]}`);
    }

    if (lines > policy.lineCap) {
      return toOwner(`${lines} lines changed, past the ${policy.lineCap}-line cap`);
    }
  }

  const deep = matching([...policy.factoryPaths, ...policy.deepReviewPaths], paths);

  if (deep.length === 0) {
    return { kind: "judged" };
  }

  const answer: RoutingAnswer = {
    land: "auto",
    review: "deep",
    secondRound: true,
    reason: `touches a path a deep review reads: ${listed(deep)}; lands once CI is green and no Important is open`,
    model: null,
  };

  const judgedPaths = paths.filter((path) => !deep.includes(path));

  return judgedPaths.length > 0 ? { kind: "ruled-then-judged", answer, judgedPaths } : { kind: "ruled", answer };
}

/** What the Routing judge is asked: nothing, or the change's diff limited to `paths`, the whole diff when null. */
export type JudgeAsk = { readonly kind: "none" } | { readonly kind: "ask"; readonly paths: readonly string[] | null };

/**
 * Which of `judgedPaths` the judge is asked about, when it reads only the diff of `patchDelta`: every one
 * when the change is routed whole or no rule names a path of its Patch delta, those the delta's own judged
 * paths share when it is mixed, none when its rules answer for the whole delta.
 */
function judgedOn(judgedPaths: readonly string[], patchDelta: RulesVerdict | null): readonly string[] {
  if (patchDelta === null || patchDelta.kind === "judged") {
    return judgedPaths;
  }

  if (patchDelta.kind === "ruled") {
    return [];
  }

  return judgedPaths.filter((path) => patchDelta.judgedPaths.includes(path));
}

/**
 * The judge's question for a change whose rules gave `verdict`, and `patchDelta` for its Patch delta, or
 * null when it is routed whole. A `judged` Patch delta asks whether to read it again; a mixed change asks
 * about the judged paths its Patch delta touches, and nothing when it touches none.
 */
export function judgeAskOf(verdict: RulesVerdict, patchDelta: RulesVerdict | null): JudgeAsk {
  if (verdict.kind === "judged") {
    return { kind: "ask", paths: null };
  }

  if (verdict.kind === "ruled-then-judged") {
    const paths = judgedOn(verdict.judgedPaths, patchDelta);

    return paths.length > 0 ? { kind: "ask", paths } : { kind: "none" };
  }

  return patchDelta?.kind === "judged" ? { kind: "ask", paths: null } : { kind: "none" };
}

/** The Routing answer of a verdict the judge was asked about: the judge's own, or the rules' raised to the Owner when the judge says so. */
function judgedRouting(verdict: Exclude<RulesVerdict, { kind: "ruled" }>, judge: RoutingAnswer): RoutingAnswer {
  if (verdict.kind === "judged") {
    return judge;
  }

  return judge.land === "owner"
    ? {
        ...verdict.answer,
        land: "owner",
        reason: `${verdict.answer.reason}; the Routing judge: ${judge.reason}`,
        model: judge.model,
      }
    : verdict.answer;
}

/**
 * The Routing answer of a change from its rules' verdicts and the judge's answer to `judgeAskOf`, null
 * when it asked nothing. A mixed change whose Patch delta asks the judge nothing keeps the rules' answer.
 * On a Patch delta, a ruled one is read again, a judged one when the judge says so.
 */
export function routingOf(
  verdict: RulesVerdict,
  patchDelta: RulesVerdict | null,
  judge: RoutingAnswer | null,
): RoutingAnswer {
  const needed = (): RoutingAnswer => {
    if (judge === null) {
      throw new Error(`the Routing judge was not asked about a ${verdict.kind} change`);
    }

    return judge;
  };

  const asked = judgeAskOf(verdict, patchDelta).kind === "ask";

  const answer =
    verdict.kind === "judged" || (verdict.kind === "ruled-then-judged" && asked)
      ? judgedRouting(verdict, needed())
      : verdict.answer;

  if (patchDelta === null || verdict.kind === "judged") {
    return answer;
  }

  return { ...answer, secondRound: patchDelta.kind !== "judged" || needed().secondRound };
}
