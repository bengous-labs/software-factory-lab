/**
 * The Merge bot's calls to GitHub, each over the `Run` port it is given: the reads that page through an
 * endpoint, and the writes that post a comment, a check, an issue or a thread's reply. The door passes the
 * real `run`; tests pass a fake.
 */

import { Schema } from "effect";

import { TRUNK } from "../../install/host.ts";
import { decodeJson } from "../../lib/json.ts";
import { checked } from "../../lib/run.port.ts";
import type { Run } from "../../lib/run.port.ts";
import type { AgainReply } from "../review/post-plan.ts";
import type { Ask } from "../shared/ask.port.ts";
import { graphqlLogin, ReviewThreads, threadsQueryOf } from "../shared/findings.ts";
import type { ReviewThread, ThreadLogins } from "../shared/findings.ts";
import { replyInThread, resolveThread } from "../shared/threads.ts";
import type { Issue } from "./ledger.ts";
import {
  checkRunBodyOf,
  CheckRuns,
  CheckSuites,
  ciRunsPathsOf,
  IssueComments,
  IssueEvents,
  notFound,
  OpenedIssue,
  PostedComment,
  PullReviews,
  pushRunsOf,
} from "./readings.ts";
import type { CheckState } from "./steps.ts";

/** What one start of the Merge bot works with: the job it runs in, the logins it trusts, and the ports its door passes. */
export interface Env {
  readonly repo: string;
  readonly owner: string;
  readonly authorLogin: string;
  readonly appLogin: string;
  readonly cwd: string;
  readonly runUrl: string;
  readonly run: Run;
  readonly ask: Ask;
}

/** The endpoint at `path`, read through `runner` and decoded by `schema`. */
const apiWith = async <S extends Schema.ConstraintDecoder<unknown>>(
  runner: Run,
  where: Pick<Env, "cwd">,
  schema: S,
  path: string,
): Promise<S["Type"]> =>
  decodeJson(schema, `gh api ${path}`, await checked(runner, ["gh", "api", "-X", "GET", path], { cwd: where.cwd }));

/** Every page of `repos/<repo>/pulls/<n>/reviews`: past 100 reviews, the latest is on a later page. */
export function reviewsReader(
  runner: Run,
): (where: Pick<Env, "repo" | "cwd">, pr: number) => Promise<typeof PullReviews.Type> {
  return async (where, pr) => {
    const path = `repos/${where.repo}/pulls/${pr}/reviews?per_page=100`;
    const out = await checked(runner, ["gh", "api", "-X", "GET", "--paginate", "--slurp", path], { cwd: where.cwd });

    return decodeJson(Schema.Array(PullReviews), `gh api ${path}`, out).flat();
  };
}

/** Every page of `repos/<repo>/issues/<n>/events`: past 100 events, the latest `labeled` is on a later page. */
export function labelEventsReader(
  runner: Run,
): (where: Pick<Env, "repo" | "cwd">, pr: number) => Promise<typeof IssueEvents.Type> {
  return async (where, pr) => {
    const path = `repos/${where.repo}/issues/${pr}/events?per_page=100`;
    const out = await checked(runner, ["gh", "api", "-X", "GET", "--paginate", "--slurp", path], { cwd: where.cwd });

    return decodeJson(Schema.Array(IssueEvents), `gh api ${path}`, out).flat();
  };
}

/** Posts `body` as a new comment on the PR: GitHub notifies a new comment, never an edit. */
export function ownerCommenter(
  runner: Run,
): (where: Pick<Env, "repo" | "cwd">, pr: number, body: string) => Promise<void> {
  return async (where, pr, body) => {
    const path = `repos/${where.repo}/issues/${pr}/comments`;

    await checked(runner, ["gh", "api", "-X", "POST", path, "--input", "-"], {
      cwd: where.cwd,
      stdin: JSON.stringify({ body }),
    });
  };
}

/** Opens `issue` on the repository, as the App; returns its number. */
export function issueOpener(runner: Run): (where: Pick<Env, "repo" | "cwd">, issue: Issue) => Promise<number> {
  return async (where, issue) => {
    const path = `repos/${where.repo}/issues`;

    const out = await checked(runner, ["gh", "api", "-X", "POST", path, "--input", "-"], {
      cwd: where.cwd,
      stdin: JSON.stringify({ title: issue.title, body: issue.body }),
    });

    return decodeJson(OpenedIssue, `gh api ${path}`, out).number;
  };
}

/** Every page of the PR's conversation comments: the Stop hook's record of the fixed findings may come past the first hundred. */
export function conversationReader(
  runner: Run,
): (where: Pick<Env, "repo" | "cwd">, pr: number) => Promise<typeof IssueComments.Type> {
  return async (where, pr) => {
    const path = `repos/${where.repo}/issues/${pr}/comments?per_page=100`;
    const out = await checked(runner, ["gh", "api", "-X", "GET", "--paginate", "--slurp", path], { cwd: where.cwd });

    return decodeJson(Schema.Array(IssueComments), `gh api ${path}`, out).flat();
  };
}

/**
 * Writes `body` as the state comment: an edit of comment `id`, or a new comment on the PR when `id` is
 * null. Returns the comment's id, so the steps after it edit the comment it posted.
 */
export function stateWriter(
  runner: Run,
): (where: Pick<Env, "repo" | "cwd">, pr: number, id: number | null, body: string) => Promise<number> {
  return async (where, pr, id, body) => {
    const [method, path] =
      id === null
        ? ["POST", `repos/${where.repo}/issues/${pr}/comments`]
        : ["PATCH", `repos/${where.repo}/issues/comments/${id}`];

    const out = await checked(runner, ["gh", "api", "-X", method, path, "--input", "-"], {
      cwd: where.cwd,
      stdin: JSON.stringify({ body }),
    });

    return id ?? decodeJson(PostedComment, `gh api ${path}`, out).id;
  };
}

/** The output of `gh api <path>`, or null when GitHub answers 404; any other failure throws. */
export async function readOrGone(runner: Run, where: Pick<Env, "repo" | "cwd">, path: string): Promise<string | null> {
  const read = await runner(["gh", "api", path], { cwd: where.cwd });

  if (notFound(read)) {
    return null;
  }

  if (read.code !== 0) {
    throw new Error(`gh api ${path} exited ${read.code}: ${(read.stderr || read.stdout).trim()}`);
  }

  return read.stdout;
}

/** The push runs of each of CI_CHECKS on the Trunk's head, as `rangeOf` fetched it. */
export function devRunsReader(
  runner: Run,
): (where: Pick<Env, "repo" | "cwd">) => Promise<ReadonlyArray<typeof CheckRuns.Type>> {
  return async (where) => {
    const devHead = (await checked(runner, ["git", "rev-parse", `origin/${TRUNK}`], { cwd: where.cwd })).trim();

    const [suites, runs] = await Promise.all([
      apiWith(runner, where, CheckSuites, `repos/${where.repo}/commits/${devHead}/check-suites?per_page=100`),
      Promise.all(ciRunsPathsOf(where.repo, devHead).map((path) => apiWith(runner, where, CheckRuns, path))),
    ]);

    return pushRunsOf(suites, runs, TRUNK);
  };
}

export function checkSetter(
  runner: Run,
): (where: Pick<Env, "repo" | "cwd" | "runUrl">, name: string, head: string, check: CheckState) => Promise<void> {
  return async (where, name, head, check) => {
    await checked(runner, ["gh", "api", "-X", "POST", `repos/${where.repo}/check-runs`, "--input", "-"], {
      cwd: where.cwd,
      stdin: JSON.stringify(checkRunBodyOf(name, head, check, where.runUrl)),
    });
  };
}

const TO_DRAFT = "mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){clientMutationId}}";

/** Sends the PR whose node id is `nodeId` back to draft. */
export function draftConverter(runner: Run): (where: Pick<Env, "cwd">, nodeId: string) => Promise<void> {
  return async (where, nodeId) => {
    await checked(runner, ["gh", "api", "-X", "POST", "graphql", "--input", "-"], {
      cwd: where.cwd,
      stdin: JSON.stringify({ query: TO_DRAFT, variables: { id: nodeId } }),
    });
  };
}

/** Resolves each review thread of `threads`, as the App. */
export function threadsResolver(runner: Run): (where: Pick<Env, "cwd">, threads: readonly string[]) => Promise<void> {
  return async (where, threads) => {
    for (const thread of threads) {
      await resolveThread(runner, { cwd: where.cwd }, thread);
    }
  };
}

/** Posts each reply in its review thread, as the App. */
export function againPoster(runner: Run): (where: Pick<Env, "cwd">, replies: readonly AgainReply[]) => Promise<void> {
  return async (where, replies) => {
    for (const reply of replies) {
      await replyInThread(runner, { cwd: where.cwd }, reply.thread, reply.body);
    }
  };
}

export const gh = (env: Env, args: readonly string[], stdin?: string): Promise<string> =>
  checked(env.run, ["gh", ...args], stdin === undefined ? { cwd: env.cwd } : { cwd: env.cwd, stdin });

export const git = async (env: Env, args: readonly string[]): Promise<string> =>
  (await checked(env.run, ["git", ...args], { cwd: env.cwd })).trim();

export const call = (env: Env, method: string, path: string, body?: Schema.JsonObject): Promise<string> =>
  body === undefined
    ? gh(env, ["api", "-X", method, path])
    : gh(env, ["api", "-X", method, path, "--input", "-"], JSON.stringify(body));

/** The endpoint at `path`, decoded by `schema`. */
export const api = <S extends Schema.ConstraintDecoder<unknown>>(
  env: Env,
  schema: S,
  path: string,
): Promise<S["Type"]> => apiWith(env.run, env, schema, path);

/** Sends `body` to the endpoint at `path`; what it answers is not read. */
export const send = async (env: Env, method: string, path: string, body?: Schema.JsonObject): Promise<void> => {
  await call(env, method, path, body);
};

const graphql = async <S extends Schema.ConstraintDecoder<unknown>>(
  env: Env,
  schema: S,
  query: string,
  variables: Readonly<Record<string, string>>,
): Promise<S["Type"]> => decodeJson(schema, "gh api graphql", await call(env, "POST", "graphql", { query, variables }));

/** Runs a GraphQL mutation; what it answers is not read. */
export const mutate = (env: Env, query: string, variables: Readonly<Record<string, string>>): Promise<void> =>
  send(env, "POST", "graphql", { query, variables });

/** The logins whose words a review thread holds that the Merge bot reads. */
export const threadLoginsOf = (env: Env): ThreadLogins => ({
  app: graphqlLogin(env.appLogin),
  author: env.authorLogin,
  owner: env.owner,
});

export async function threadsOf(env: Env, pr: number): Promise<readonly ReviewThread[]> {
  const [owner, name] = env.repo.split("/");
  const out = await graphql(env, ReviewThreads, threadsQueryOf(pr), { owner: owner ?? "", name: name ?? "" });

  return out.data.repository.pullRequest.reviewThreads.nodes;
}
