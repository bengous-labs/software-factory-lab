#!/usr/bin/env bun

/**
 * The author's PR watch, armed with Monitor on its PR: every 30 s it reads the PR and prints one line
 * per Wake: a failing check, a new open Important finding, a new comment in an open thread or in the
 * PR's conversation, the PR moved to draft. The App's own Nit and Pre-existing findings and its
 * conversation comments (state record, verdicts) print nothing; nor do the author's own replies and
 * comments, which `thread.ts` and `comment.ts` mark, since an author and a human reviewer can post
 * under one gh identity.
 * When the PR is landed or closed, it prints its end line and exits. What it printed is kept in
 * `.lab/state/watch-<pr>.json`, so a PR watch armed again after an expiry repeats nothing.
 *
 *   bun scripts/land-loop/pr-watch.ts <pr>
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Schema } from "effect";

import { decodeJson } from "../lib/json.ts";
import { AUTHOR_MARK } from "./author-mark.ts";
import { checked, run } from "./lib/run.ts";
import type { Run } from "./ports/run.ts";
import { severityOfBody } from "./review/findings.ts";

const POLL_MS = 30_000;

/** The App's login as GraphQL prints it: only its own Nit and Pre-existing findings are skipped. */
export const APP_LOGIN = "bengous-labs-agents";

/** One check as `gh pr checks --json name,bucket,link` prints it. */
export const Check = Schema.Struct({ name: Schema.String, bucket: Schema.String, link: Schema.String });

export type Check = typeof Check.Type;

export interface Comment {
  readonly id: string;
  readonly author: string;
  readonly body: string;
}

/** One conversation comment as the `--jq` filter of `read` prints it; a deleted user's has a null author. */
const ConversationComment = Schema.Struct({
  id: Schema.String,
  author: Schema.NullOr(Schema.String),
  body: Schema.String,
});

export interface Thread {
  readonly id: string;
  readonly resolved: boolean;
  readonly path: string;
  readonly line: number | null;
  readonly author: string;
  readonly body: string;
  /** The comments after the first one. */
  readonly replies: readonly Comment[];
}

export interface PrState {
  readonly state: "OPEN" | "MERGED" | "CLOSED";
  readonly draft: boolean;
  readonly head: string;
  readonly checks: readonly Check[];
  readonly threads: readonly Thread[];
  /** The PR's conversation comments. */
  readonly comments: readonly Comment[];
}

export interface Wake {
  readonly key: string;
  readonly line: string;
}

/** The key that keeps the end line from being printed twice. */
export const END_KEY = "end";

const flat = (body: string): string => body.replaceAll(/\s+/gu, " ").slice(0, 400);

/** The end line of a landed or closed PR; null while it is open. */
export function endOf(pr: number, state: PrState): string | null {
  if (state.state === "MERGED") {
    return `PR #${pr} landed. Stop watching.`;
  }

  if (state.state === "CLOSED") {
    return `PR #${pr} closed. Stop watching.`;
  }

  return null;
}

/** The Wakes of one reading of an open PR, each with the key that keeps it from being printed twice. */
export function wakesOf(pr: number, state: PrState): readonly Wake[] {
  const short = state.head.slice(0, 7);

  if (state.state !== "OPEN") {
    return [];
  }

  const wakes: Wake[] = state.checks
    .filter((check) => check.bucket === "fail")
    .map((check) => ({
      key: `check:${check.name}:${state.head}`,
      line: `Check ${check.name} failed on ${short}: ${check.link}`,
    }));

  for (const thread of state.threads.filter((found) => !found.resolved)) {
    const severity = thread.author === APP_LOGIN ? severityOfBody(thread.body) : null;
    const where = thread.line === null ? thread.path : `${thread.path}:${thread.line}`;

    if (severity !== "nit" && severity !== "pre_existing") {
      const kind = severity === "important" ? "Finding" : "Comment";
      wakes.push({
        key: `thread:${thread.id}`,
        line: `${kind} ${thread.id} on ${where} by ${thread.author}: ${flat(thread.body)}`,
      });
    }

    for (const reply of thread.replies.filter(
      (found) => found.author !== APP_LOGIN && !found.body.includes(AUTHOR_MARK),
    )) {
      wakes.push({
        key: `comment:${reply.id}`,
        line: `Reply in ${thread.id} on ${where} by ${reply.author}: ${flat(reply.body)}`,
      });
    }
  }

  for (const comment of state.comments.filter(
    (found) => found.author !== APP_LOGIN && !found.body.includes(AUTHOR_MARK),
  )) {
    wakes.push({
      key: `comment:${comment.id}`,
      line: `Comment on PR #${pr} by ${comment.author}: ${flat(comment.body)}`,
    });
  }

  if (state.draft) {
    wakes.push({
      key: `draft:${state.head}`,
      line: `PR #${pr} is a draft again at ${short}: fix or answer the findings, then stop.`,
    });
  }

  return wakes;
}

/**
 * What one reading prints, each line `seen` does not hold yet, and whether the PR watch ends. A landed
 * or closed PR ends it at once, even for a PR watch armed again after its end line was printed.
 */
export interface Reading {
  readonly wakes: readonly Wake[];
  readonly ends: boolean;
}

export function readingOf(pr: number, state: PrState, seen: ReadonlySet<string>): Reading {
  const end = endOf(pr, state);
  const wakes = end === null ? wakesOf(pr, state) : [{ key: END_KEY, line: end }];

  return { wakes: wakes.filter((wake) => !seen.has(wake.key)), ends: end !== null };
}

const PrView = Schema.Struct({
  state: Schema.Literals(["OPEN", "MERGED", "CLOSED"]),
  isDraft: Schema.Boolean,
  headRefOid: Schema.String,
});

const Author = Schema.NullOr(Schema.Struct({ login: Schema.String }));

const ReviewThreads = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      pullRequest: Schema.Struct({
        reviewThreads: Schema.Struct({
          nodes: Schema.Array(
            Schema.Struct({
              id: Schema.String,
              isResolved: Schema.Boolean,
              path: Schema.String,
              line: Schema.NullOr(Schema.Finite),
              comments: Schema.Struct({
                nodes: Schema.Array(Schema.Struct({ id: Schema.String, author: Author, body: Schema.String })),
              }),
            }),
          ),
        }),
      }),
    }),
  }),
});

/** The keys this PR watch printed, as `print` writes them to `.lab/state/watch-<pr>.json`. */
export const SeenKeys = Schema.Array(Schema.String);

/** A PR's state from what gh printed: its view, its checks, its conversation's lines and its review threads. */
export function prStateOf(view: string, checks: string, conversation: string, threads: string): PrState {
  const { state, isDraft, headRefOid } = decodeJson(PrView, "gh pr view", view);

  const nodes = decodeJson(ReviewThreads, "the review threads query", threads).data.repository.pullRequest.reviewThreads
    .nodes;

  return {
    state,
    draft: isDraft,
    head: headRefOid,
    // `gh pr checks` exits 8 while checks are pending and 1 when one fails; its JSON is printed either way.
    checks: checks.trim() === "" ? [] : decodeJson(Schema.Array(Check), "gh pr checks", checks),
    threads: nodes.map((node) => ({
      id: node.id,
      resolved: node.isResolved,
      path: node.path,
      line: node.line,
      author: node.comments.nodes[0]?.author?.login ?? "unknown",
      body: node.comments.nodes[0]?.body ?? "",
      replies: node.comments.nodes
        .slice(1)
        .map((comment) => ({ id: comment.id, author: comment.author?.login ?? "unknown", body: comment.body })),
    })),
    comments: conversation
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const comment = decodeJson(ConversationComment, "a conversation comment", line);

        return { ...comment, author: comment.author?.replace(/\[bot\]$/u, "") ?? "unknown" };
      }),
  };
}

async function read(runner: Run, pr: number): Promise<PrState> {
  const cwd = process.cwd();

  const view = await checked(runner, ["gh", "pr", "view", String(pr), "--json", "state,isDraft,headRefOid"], {
    cwd,
  });

  const checks = await runner(["gh", "pr", "checks", String(pr), "--json", "name,bucket,link"], { cwd });

  const repo = (
    await checked(runner, ["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd })
  ).trim();

  const [owner, name] = repo.split("/");

  const conversation = await checked(
    runner,
    [
      "gh",
      "api",
      "--paginate",
      `repos/${repo}/issues/${pr}/comments?per_page=100`,
      "--jq",
      ".[] | {id: (.id | tostring), author: .user.login, body}",
    ],
    { cwd },
  );

  const threads = await checked(
    runner,
    [
      "gh",
      "api",
      "graphql",
      "-f",
      `query=query{repository(owner:"${owner}",name:"${name}"){pullRequest(number:${pr}){reviewThreads(first:100){nodes{id isResolved path line comments(first:50){nodes{id author{login} body}}}}}}}`,
    ],
    { cwd },
  );

  return prStateOf(view, checks.stdout, conversation, threads);
}

if (import.meta.main) {
  const pr = Number(process.argv[2]);

  if (!Number.isInteger(pr)) {
    throw new TypeError("usage: bun scripts/land-loop/pr-watch.ts <pr>");
  }

  const stateDir = join(process.cwd(), ".lab", "state");
  mkdirSync(stateDir, { recursive: true });
  // An on-disk name: existing state files carry it, so it stays.
  const seenFile = join(stateDir, `watch-${pr}.json`);

  const seen = new Set<string>(
    existsSync(seenFile) ? decodeJson(SeenKeys, seenFile, readFileSync(seenFile, "utf8")) : [],
  );

  const print = (key: string, line: string): void => {
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    writeFileSync(seenFile, JSON.stringify([...seen]));
    console.log(line);
  };

  for (;;) {
    try {
      const reading = readingOf(pr, await read(run, pr), seen);

      for (const wake of reading.wakes) {
        print(wake.key, wake.line);
      }

      if (reading.ends) {
        process.exit(0);
      }
    } catch (error) {
      console.error(`pr-watch: ${error instanceof Error ? error.message : String(error)}`);
    }

    await Bun.sleep(POLL_MS);
  }
}
