/**
 * The route of one patch: the Routing rules over what git says of its range, then the Routing judge when
 * the rules leave it a question. The judge reads a worktree of the PR's head, made for the call and removed
 * after it, with no git config of the runner and no hook.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FACTORY_CONFIG_PATH, factoryConfigOf } from "../../install/factory-config.ts";
import type { RoutingPolicy } from "../../install/factory-config.ts";
import { checked } from "../../lib/run.port.ts";
import type { Run, RunOptions } from "../../lib/run.port.ts";
import { ROUTING_JUDGE } from "../routing/routing-judge.actor.ts";
import { judgeFailed, routingJudge } from "../routing/routing-judge.ts";
import type { RoutingVerdict } from "../routing/routing-judge.ts";
import { judgeAskOf, patchDeltaRulesOf, routingOf, routingRulesOf, withNitAnswers } from "../routing/routing-rules.ts";
import type { JudgeAsk, RoutingAnswer } from "../routing/routing-rules.ts";
import type { Reader } from "../shared/ask.port.ts";
import { graphqlLogin, nitPathsOf } from "../shared/findings.ts";
import { resolverOf } from "../shared/resolve.live.ts";
import { readGuardOf } from "../shared/tool-guard.ts";
import type { Env } from "./github.ts";
import { git, threadsOf } from "./github.ts";
import type { StateRecord } from "./record.ts";
import {
  changedPathsArgs,
  deletedPathsArgs,
  judgeDiffArgs,
  judgeEnvOf,
  linesChanged,
  pathsListed,
  rangeStart,
} from "./routing-inputs.ts";
import type { JobEnv, Range } from "./routing-inputs.ts";

/** The routing policy of the factory config in `checkout`: the Merge bot's own checkout of the Trunk, never a PR's head. */
export function routingPolicyAt(checkout: string): RoutingPolicy {
  return factoryConfigOf(readFileSync(join(checkout, FACTORY_CONFIG_PATH), "utf8")).land.routing;
}

interface Checkout {
  readonly run: Run;
  /** The Merge bot's checkout, which holds the PR's head. */
  readonly cwd: string;
  readonly head: string;
}

/**
 * The git of the worktree's checkout, in a job that holds the App's token: no system or global config,
 * so no filter driver a PR's `.gitattributes` names runs, the LFS one the runner installs included, and
 * no hook.
 */
const CHECKOUT_GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: "/dev/null",
};

const worktreeAt = (checkout: Checkout): RunOptions => ({ cwd: checkout.cwd, env: CHECKOUT_GIT_ENV });

async function inWorktree<T>(checkout: Checkout, tree: string, read: (root: string) => Promise<T>): Promise<T> {
  await checked(checkout.run, ["git", "worktree", "add", "--detach", tree, checkout.head], worktreeAt(checkout));

  try {
    return await read(realpathSync(tree));
  } finally {
    await checkout.run(["git", "worktree", "remove", "--force", tree], worktreeAt(checkout));
  }
}

/**
 * The Routing judge's answer when `question` asks it, else null. The judge reads a worktree of the PR's
 * head, made for the call and removed after it, under the read guard. A worktree or an environment that
 * cannot be made, or a call that throws, answers the safe side, so one PR never stops a Sweep.
 */
export async function judgeAt(
  question: JudgeAsk,
  checkout: Checkout,
  job: JobEnv,
  judge: (reader: Reader) => Promise<RoutingVerdict>,
): Promise<RoutingVerdict | null> {
  if (question.kind === "none") {
    return null;
  }

  const dir = mkdtempSync(join(tmpdir(), "routing-judge-"));
  const configDir = join(dir, "config");

  try {
    return await inWorktree(checkout, join(dir, "pr"), (root) => {
      mkdirSync(configDir);

      return judge({
        cwd: root,
        guard: readGuardOf({ root, resolve: resolverOf(root) }),
        env: judgeEnvOf(job, configDir),
      });
    });
  } catch (error) {
    return {
      routing: judgeFailed(error instanceof Error ? error.message : String(error), ROUTING_JUDGE.model),
      tokens: null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await checkout.run(["git", "worktree", "prune"], worktreeAt(checkout));
  }
}

export async function route(
  env: Env,
  range: Range,
  record: StateRecord,
  { patchDelta, pr }: { readonly patchDelta: boolean; readonly pr: number },
): Promise<{ readonly answer: RoutingAnswer; readonly judge: RoutingVerdict | null }> {
  const policy = routingPolicyAt(env.cwd);
  const from = await rangeStart(env, range, record, patchDelta);
  const paths = await pathsListed(env, changedPathsArgs(range.base, range.head));
  const deletedPaths = await pathsListed(env, deletedPathsArgs(range.base, range.head));
  const lines = await linesChanged(env, range.base, range.head);

  const messages = (await git(env, ["log", "--format=%B%x00", `${range.base}..${range.head}`]))
    .split("\0")
    .map((message) => message.trim())
    .filter((message) => message !== "");

  const rules = routingRulesOf(policy, { paths, lines, deletedPaths, messages });

  // The Routing rules hold the labels of the whole PR; whether this Patch delta is read again is its own
  // question, on its own paths and lines. A breaking commit is judged on the whole PR.
  const delta = patchDelta
    ? {
        paths: await pathsListed(env, changedPathsArgs(from, range.head)),
        lines: await linesChanged(env, from, range.head),
        deletedPaths: await pathsListed(env, deletedPathsArgs(from, range.head)),
        messages: [],
      }
    : null;

  const patchDeltaRules = delta === null ? null : patchDeltaRulesOf(policy, delta);

  const question = judgeAskOf(rules, patchDeltaRules);

  const judge = await judgeAt(question, { run: env.run, cwd: env.cwd, head: range.head }, process.env, async (reader) =>
    routingJudge(
      env.ask,
      reader,
      await git(env, judgeDiffArgs(from, range.head, true)),
      await git(env, judgeDiffArgs(from, range.head, false)),
      patchDelta,
    ),
  );

  const answer = routingOf(rules, patchDeltaRules, judge?.routing ?? null);

  if (delta === null) {
    return { answer, judge };
  }

  const nitPaths = nitPathsOf(
    graphqlLogin(env.appLogin),
    { patch: record.reviewedPatch, round: record.reviewRounds },
    await threadsOf(env, pr),
  );

  return { answer: withNitAnswers(policy, answer, delta, { record, deltaFrom: from, nitPaths }), judge };
}
