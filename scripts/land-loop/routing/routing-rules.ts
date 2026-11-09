/**
 * The Routing rules: what sets a change's Land route and Review depth whatever a model says of it, under
 * the routing policy of the factory config. A path of `ownerPaths`, or the factory config itself, sends
 * the change to the Owner. A path of `factoryPaths` or `deepReviewPaths` gets a deep Code review and
 * lands without the Owner once CI is green and no Important is open. A change that touches a path
 * outside `factoryPaths` goes to the Owner when one of its commits is breaking. A change past `lineCap`
 * gets a deep Code review. The Routing judge answers the Review depth of the paths no rule names; it
 * never sets the Land route.
 */

import { FACTORY_CONFIG_PATH } from "../factory-config.ts";
import type { RoutingPolicy } from "../factory-config.ts";
import type { RoutingAnswer, StateRecord } from "../merge-bot/decide.ts";

const BREAKING = /^\w+(\([^)]*\))?!:|BREAKING CHANGE/mu;

export interface RoutingInput {
  readonly paths: readonly string[];
  readonly lines: number;
  readonly messages: readonly string[];
}

/** What the Routing rules make of a change: `ruled`, their answer stands; `judged`, the Routing judge answers. */
export type RulesVerdict = { readonly kind: "ruled"; readonly answer: RoutingAnswer } | { readonly kind: "judged" };

const ruled = (land: RoutingAnswer["land"], reason: string): RulesVerdict => ({
  kind: "ruled",
  answer: { land, review: "deep", secondRound: true, reason, model: null },
});

/** The paths that match at least one of `globs`. */
export function matching(globs: readonly string[], paths: readonly string[]): readonly string[] {
  const compiled = globs.map((glob) => new Bun.Glob(glob));

  return paths.filter((path) => compiled.some((glob) => glob.match(path)));
}

const listed = (paths: readonly string[]): string => paths.slice(0, 3).join(", ");

export function routingRulesOf(policy: RoutingPolicy, { paths, lines, messages }: RoutingInput): RulesVerdict {
  if (paths.length === 0) {
    throw new Error("the Routing rules route a change that touches at least one file");
  }

  const owner = matching([FACTORY_CONFIG_PATH, ...policy.ownerPaths], paths);

  if (owner.length > 0) {
    return ruled("owner", `touches a path the Owner lands: ${listed(owner)}`);
  }

  const breaking = messages.find((message) => BREAKING.test(message));

  if (breaking !== undefined && matching(policy.factoryPaths, paths).length < paths.length) {
    return ruled("owner", `a breaking commit: ${breaking.split("\n")[0]}`);
  }

  if (lines > policy.lineCap) {
    return ruled("auto", `${lines} lines changed, past the ${policy.lineCap}-line cap`);
  }

  const deep = matching([...policy.factoryPaths, ...policy.deepReviewPaths], paths);

  return deep.length === 0
    ? { kind: "judged" }
    : ruled(
        "auto",
        `touches a path a deep review reads: ${listed(deep)}; lands once CI is green and no Important is open`,
      );
}

/**
 * The rules' verdict on a Patch delta. One that touches no file, a head whose tree the last review read
 * over a base that has since taken in some of the PR's change, has nothing to read again.
 */
export function patchDeltaRulesOf(policy: RoutingPolicy, delta: RoutingInput): RulesVerdict {
  return delta.paths.length === 0
    ? {
        kind: "ruled",
        answer: {
          land: "auto",
          review: "deep",
          secondRound: false,
          reason: "the Patch delta touches no file: nothing to read again",
          model: null,
        },
      }
    : routingRulesOf(policy, delta);
}

/** Whether the Routing judge is asked about a change: it then reads the whole diff of its range. */
export type JudgeAsk = { readonly kind: "none" } | { readonly kind: "ask" };

/**
 * The judge's question for a change whose rules gave `verdict`, and `patchDelta` for its Patch delta, or
 * null when it is routed whole: asked when what it reads, the Patch delta or else the whole change, is
 * `judged`.
 */
export function judgeAskOf(verdict: RulesVerdict, patchDelta: RulesVerdict | null): JudgeAsk {
  return (patchDelta ?? verdict).kind === "judged" ? { kind: "ask" } : { kind: "none" };
}

/**
 * The Routing answer of a change from its rules' verdicts and the judge's answer to `judgeAskOf`, null
 * when it asked nothing. The rules alone set the Land route: the judge's answer lands `auto`. On a Patch
 * delta, a ruled change keeps the rules' answer and is read again when its ruled delta says so, when
 * the judge says so when it is judged; a judged change whose delta is ruled takes the delta's Review depth,
 * and still lands `auto`.
 */
export function routingOf(
  verdict: RulesVerdict,
  patchDelta: RulesVerdict | null,
  judge: RoutingAnswer | null,
): RoutingAnswer {
  const judged = (): RoutingAnswer => {
    if (judge === null) {
      throw new Error("the Routing judge was not asked about a judged change");
    }

    return { ...judge, land: "auto" };
  };

  if (patchDelta === null) {
    return verdict.kind === "ruled" ? verdict.answer : judged();
  }

  if (verdict.kind === "judged") {
    return patchDelta.kind === "ruled" ? { ...patchDelta.answer, land: "auto" } : judged();
  }

  return {
    ...verdict.answer,
    secondRound: patchDelta.kind === "ruled" ? patchDelta.answer.secondRound : judged().secondRound,
  };
}

/** The most lines a push after Review round 3 changes and still only answers its Nits. */
export const NIT_ANSWER_LINE_CAP = 100;

/** What a Patch delta after Review round 3 is weighed against. */
export interface NitAnswerInput {
  /** The PR's state record: its rounds, each round's Important count, the head the last round read. */
  readonly record: Pick<StateRecord, "reviewRounds" | "importantByRound" | "reviewedHead">;
  /** Where the Patch delta starts: the head the last round read, or the merge base once that head left the PR's history. */
  readonly deltaFrom: string;
  /** The files Review round 3 posted a Nit finding on. */
  readonly nitPaths: readonly string[];
}

/**
 * The Routing answer of a Patch delta that only answers the Nits of a Review round 3 that posted no
 * Important: the delta starts at the head round 3 read, touches only files round 3 posted a Nit on and
 * no `deepReviewPaths` path, in at most NIT_ANSWER_LINE_CAP lines. It needs no read, so it holds nothing
 * for the Owner and the change keeps its Land route. Any other answer stands.
 */
export function withNitAnswers(
  policy: RoutingPolicy,
  answer: RoutingAnswer,
  delta: RoutingInput,
  { record, deltaFrom, nitPaths }: NitAnswerInput,
): RoutingAnswer {
  const nits = new Set(nitPaths);

  const answersNits =
    answer.secondRound &&
    record.reviewRounds === 3 &&
    record.importantByRound?.[2] === 0 &&
    record.reviewedHead === deltaFrom &&
    delta.lines <= NIT_ANSWER_LINE_CAP &&
    delta.paths.every((path) => nits.has(path)) &&
    matching(policy.deepReviewPaths, delta.paths).length === 0;

  if (!answersNits) {
    return answer;
  }

  const nitAnswer = `a push after Review round 3 that only answers its Nits: ${delta.lines} lines in ${listed(delta.paths)}`;

  // The Owner's route keeps its reason alone: the land-gate and the Owner's comment give it as why the PR is held.
  return { ...answer, secondRound: false, reason: answer.land === "owner" ? answer.reason : nitAnswer };
}
