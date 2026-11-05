#!/usr/bin/env bun

/**
 * The author's watcher, armed with Monitor on its PR: every 30 s it reads the PR and prints one line
 * per event the author acts on: a failing check, a new open Important finding, a new comment in an open
 * thread or in the PR's conversation, the PR moved to draft. The App's own Nit and Pre-existing findings
 * and its conversation comments (state record, verdicts) print nothing; nor do the author's own replies,
 * which `thread.ts` marks, since an author and a human reviewer can post under one gh identity.
 * It exits when the PR is merged or closed. What it printed is kept in `.lab/state/watch-<pr>.json`,
 * so a watcher armed again after an expiry repeats nothing.
 *
 *   bun scripts/harness/watch.ts <pr>
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { checked, run, type Run } from "./lib/run.ts";
import { severityOfBody } from "./review/findings.ts";
import { AUTHOR_MARK } from "./thread.ts";

const POLL_MS = 30_000;

/** The App's login as GraphQL prints it: only its own Nit and Pre-existing findings are skipped. */
export const APP_LOGIN = "bengous-labs-agents";

export interface Check {
  readonly name: string;
  readonly bucket: string;
  readonly link: string;
}

export interface Comment {
  readonly id: string;
  readonly author: string;
  readonly body: string;
}

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

export interface Event {
  readonly key: string;
  readonly line: string;
}

const flat = (body: string): string => body.replace(/\s+/gu, " ").slice(0, 400);

/** The events of one reading, each with the key that keeps it from being printed twice. */
export function eventsOf(pr: number, state: PrState): readonly Event[] {
  const short = state.head.slice(0, 7);

  if (state.state === "MERGED") return [{ key: "end", line: `PR #${pr} merged. Stop watching.` }];

  if (state.state === "CLOSED") return [{ key: "end", line: `PR #${pr} closed. Stop watching.` }];

  const events: Event[] = state.checks
    .filter((check) => check.bucket === "fail")
    .map((check) => ({
      key: `check:${check.name}:${state.head}`,
      line: `Check ${check.name} failed on ${short}: ${check.link}`,
    }));

  for (const thread of state.threads.filter((found) => !found.resolved)) {
    const severity = thread.author === APP_LOGIN ? severityOfBody(thread.body) : null;
    const where = thread.line === null ? thread.path : `${thread.path}:${thread.line}`;

    if (severity !== "nit" && severity !== "pre_existing") {
      events.push({ key: `thread:${thread.id}`, line: `Finding ${thread.id} on ${where} by ${thread.author}: ${flat(thread.body)}` });
    }

    for (const reply of thread.replies.filter((found) => found.author !== APP_LOGIN && !found.body.includes(AUTHOR_MARK))) {
      events.push({ key: `comment:${reply.id}`, line: `Reply in ${thread.id} on ${where} by ${reply.author}: ${flat(reply.body)}` });
    }
  }

  for (const comment of state.comments.filter((found) => found.author !== APP_LOGIN && !found.body.includes(AUTHOR_MARK))) {
    events.push({ key: `comment:${comment.id}`, line: `Comment on PR #${pr} by ${comment.author}: ${flat(comment.body)}` });
  }

  if (state.draft) {
    events.push({
      key: `draft:${state.head}`,
      line: `PR #${pr} is a draft again at ${short}: fix or answer the findings, then stop.`,
    });
  }

  return events;
}

async function read(runner: Run, pr: number): Promise<PrState> {
  const cwd = process.cwd();
  const view = JSON.parse(
    await checked(runner, ["gh", "pr", "view", String(pr), "--json", "state,isDraft,headRefOid"], { cwd }),
  ) as { state: PrState["state"]; isDraft: boolean; headRefOid: string };
  const checks = await runner(["gh", "pr", "checks", String(pr), "--json", "name,bucket,link"], { cwd });
  const repo = (await checked(runner, ["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd })).trim();
  const [owner, name] = repo.split("/");
  const conversation = await checked(
    runner,
    ["gh", "api", "--paginate", `repos/${repo}/issues/${pr}/comments?per_page=100`, "--jq", ".[] | {id: (.id | tostring), author: .user.login, body}"],
    { cwd },
  );
  const threads = JSON.parse(
    await checked(
      runner,
      [
        "gh",
        "api",
        "graphql",
        "-f",
        `query=query{repository(owner:"${owner}",name:"${name}"){pullRequest(number:${pr}){reviewThreads(first:100){nodes{id isResolved path line comments(first:50){nodes{id author{login} body}}}}}}}`,
      ],
      { cwd },
    ),
  ) as {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: {
              id: string;
              isResolved: boolean;
              path: string;
              line: number | null;
              comments: { nodes: { id: string; author: { login: string } | null; body: string }[] };
            }[];
          };
        };
      };
    };
  };

  return {
    state: view.state,
    draft: view.isDraft,
    head: view.headRefOid,
    // `gh pr checks` exits 8 while checks are pending and 1 when one fails; its JSON is printed either way.
    checks: checks.stdout.trim() === "" ? [] : (JSON.parse(checks.stdout) as Check[]),
    threads: threads.data.repository.pullRequest.reviewThreads.nodes.map((node) => ({
      id: node.id,
      resolved: node.isResolved,
      path: node.path,
      line: node.line,
      author: node.comments.nodes[0]?.author?.login ?? "unknown",
      body: node.comments.nodes[0]?.body ?? "",
      replies: node.comments.nodes.slice(1).map((comment) => ({ id: comment.id, author: comment.author?.login ?? "unknown", body: comment.body })),
    })),
    comments: conversation
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Comment)
      .map((comment) => ({ ...comment, author: comment.author.replace(/\[bot\]$/u, "") })),
  };
}

if (import.meta.main) {
  const pr = Number(process.argv[2]);

  if (!Number.isInteger(pr)) throw new Error("usage: bun scripts/harness/watch.ts <pr>");

  const stateDir = join(process.cwd(), ".lab", "state");
  mkdirSync(stateDir, { recursive: true });
  const seenFile = join(stateDir, `watch-${pr}.json`);
  const seen = new Set<string>(existsSync(seenFile) ? (JSON.parse(readFileSync(seenFile, "utf8")) as string[]) : []);

  for (;;) {
    try {
      for (const event of eventsOf(pr, await read(run, pr))) {
        if (seen.has(event.key)) continue;

        seen.add(event.key);
        writeFileSync(seenFile, JSON.stringify([...seen]));
        console.log(event.line);

        if (event.key === "end") process.exit(0);
      }
    } catch (error) {
      console.error(`watch: ${error instanceof Error ? error.message : String(error)}`);
    }

    await Bun.sleep(POLL_MS);
  }
}
