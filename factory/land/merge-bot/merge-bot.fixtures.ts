/**
 * What the tests of the Merge bot share: a PR ready to land with its Routing answer and readers of the
 * steps a decision returns, GitHub's answers as the shell reads them, and a git repository to route.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import type { Ran, Run } from "../../lib/run.port.ts";
import type { ReportedFinding, ReportedResult, ReviewResult } from "../review/review-report.ts";
import type { RoutingAnswer } from "../routing/routing-rules.ts";
import type { LedgerFinding } from "../shared/finding.ts";
import { decide } from "./decide.ts";
import type { Env } from "./env.ts";
import type { CheckRuns, IssueEvents } from "./readings.ts";
import { EMPTY_RECORD } from "./record.ts";
import type { StateRecord } from "./record.ts";
import type { ReviewJob, Snapshot } from "./snapshot.ts";
import type { Step } from "./steps.ts";

export const P1 = "patch-1";

export const LIGHT: RoutingAnswer = {
  land: "auto",
  review: "light",
  secondRound: false,
  reason: "ordinary code",
  model: "claude-haiku-5-5",
};

export const READY: Snapshot = {
  number: 9,
  state: "OPEN",
  sameRepository: true,
  openedByFactory: true,
  openedByAuthor: false,
  draft: false,
  head: "h1",
  patch: P1,
  empty: false,
  ci: "success",
  labels: [],
  humanLabelBy: null,
  landApprovalByOwner: false,
  landApprovalPutByOwner: false,
  openImportant: [],
  rejectedImportant: 0,
  devRed: false,
  conflicting: false,
  record: { ...EMPTY_RECORD, triage: { [P1]: LIGHT } },
  now: "2026-11-07T12:00:00.000Z",
  reviewJob: null,
};

/** `count` open Important threads of the App, each posted by Review round 1 of an earlier patch. */
export const important = (count: number): Snapshot["openImportant"] =>
  Array.from({ length: count }, (_, index) => ({ thread: `T${index + 1}`, review: { patch: "patch-0", round: 1 } }));

export function stepsOf(snapshot: Snapshot): readonly Step[] {
  const decision = decide(snapshot);

  if (decision.kind !== "steps") {
    throw new Error(`ignored: ${decision.reason}`);
  }

  return decision.steps;
}

export const kinds = (snapshot: Snapshot): string[] => stepsOf(snapshot).map((step) => step.kind);

export const gate = (snapshot: Snapshot): string | undefined => {
  const step = stepsOf(snapshot).find((found) => found.kind === "land-gate");

  return step?.kind === "land-gate" ? step.check.kind : undefined;
};

/** The record after a clean Review round 3 of an earlier patch, with `routing` for this one. */
export const afterRound3 = (routing: RoutingAnswer, rest: Partial<StateRecord> = {}): StateRecord => ({
  ...EMPTY_RECORD,
  reviewRounds: 3,
  reviewedPatch: "patch-0",
  reviewedHead: "h0",
  importantByRound: [1, 1, 0],
  triage: { [P1]: routing },
  ...rest,
});

export const reviewed = (routing: RoutingAnswer, rest: Partial<StateRecord> = {}): StateRecord => ({
  ...EMPTY_RECORD,
  reviewedPatch: P1,
  reviewedHead: "h0",
  reviewRounds: 1,
  triage: { [P1]: routing },
  ...rest,
});

export const finding = (severity: ReportedFinding["severity"]): ReportedFinding => ({
  file: "a.ts",
  line: 3,
  severity,
  summary: "s",
  failureScenario: "f",
  breaks: null,
  earlier: null,
  pass: "code",
});

/** An Important that reports again the earlier one in `thread`. */
export const again = (thread: string): ReportedFinding => ({ ...finding("important"), earlier: thread });

/** A Delta read of P1 that reports `findings`. */
export const read = (...findings: ReportedFinding[]): ReportedResult => ({
  kind: "reported",
  report: { findings, namesEarlier: true },
  request: {
    pr: 9,
    head: "a".repeat(40),
    base: "b".repeat(40),
    patch: P1,
    round: 4,
    model: "sonnet",
    effort: "medium",
    security: false,
  },
  model: "claude-sonnet-5-5",
  claudeCodeVersion: "2.1.318",
  tokens: null,
  runUrl: "u",
});

export const GREEN: Step = { kind: "review-check", check: { kind: "success", summary: "No Important finding open." } };

export const red = (open: number): Step => ({
  kind: "review-check",
  check: { kind: "failure", summary: `${open} Important finding(s) open.` },
});

export const completed = (result: ReviewResult | null, conclusion = "success"): ReviewJob => ({
  kind: "completed",
  conclusion,
  result,
});

/** The Review check of a failed Review round 1 of run 42. */
export const failure = (cause: string): Step => ({
  kind: "review-check",
  check: { kind: "failure", summary: `Review round 1 failed (run 42): ${cause}` },
});

export const EARLIER_PATCH_COMMENT =
  "The Land approval (land-ok) was given before this push or before its latest review, so the Merge bot removed it: an approval covers only what the Owner could read. The land-gate check of this push says whether it waits for the Owner.";

export const gateSummary = (snapshot: Snapshot): string | undefined => {
  const step = stepsOf(snapshot).find((found) => found.kind === "land-gate");

  return step?.kind === "land-gate" ? step.check.summary : undefined;
};

/**
 * A finding of the App as the ledger reads it: an open Important of round 1 on `app/src/cli.ts:7`, unless
 * `over` says otherwise; a resolved one the App closed, as it closes them.
 */
export const ledgerFinding = (thread: string, over: Partial<LedgerFinding> = {}): LedgerFinding => ({
  thread,
  url: `https://github.com/o/r/pull/9#discussion_${thread}`,
  where: "app/src/cli.ts:7",
  file: "app/src/cli.ts",
  severity: "important",
  security: false,
  summary: `${thread} is wrong`,
  round: 1,
  resolved: false,
  closedByApp: over.resolved === true,
  landedOpen: false,
  outdated: false,
  rejection: null,
  ownerAnswer: null,
  again: [],
  ...over,
});

/** The link to `thread`'s finding, as `ledgerFinding` gives it. */
export const urlOf = (thread: string): string => `https://github.com/o/r/pull/9#discussion_${thread}`;

/** The place of `thread`'s finding in its ledger line: `where`, linked. */
export const at = (where: string, thread: string): string => `[\`${where}\`](${urlOf(thread)})`;

/** `count` comments of the Owner, numbered from `from`. */
export const page = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: from + index, user: { login: "bengous" }, body: "hello" }));

export const WHERE = { repo: "o/r", cwd: "/tmp" };

export const ok = (stdout: string): Ran => ({ code: 0, stdout, stderr: "" });

/** The variables `merge-bot.yml` gives the Merge bot's job, each login its own, as `envOf` reads them. */
export const JOB_VARIABLES = {
  GITHUB_REPOSITORY: "o/r",
  GITHUB_SERVER_URL: "https://github.example",
  GITHUB_RUN_ID: "5",
  OWNER: "the-owner",
  AUTHOR_LOGIN: "the-author",
  APP_LOGIN: "the-app[bot]",
};

interface Call {
  readonly argv: readonly string[];
  readonly cwd: string | undefined;
  readonly stdin: string | undefined;
}

/** The Merge bot's ports over a run that answers each command by its arguments, and the calls it got. */
export function commandsAnswering(answers: Readonly<Record<string, Ran>>) {
  const calls: Call[] = [];

  const run: Run = (argv, options) => {
    calls.push({ argv: [...argv], cwd: options.cwd, stdin: options.stdin });
    const ran = answers[argv.slice(1).join(" ")];

    return ran === undefined
      ? Promise.reject(new Error(`unexpected command: ${argv.join(" ")}`))
      : Promise.resolve(ran);
  };

  const env: Env = {
    ...WHERE,
    owner: "the-owner",
    authorLogin: "the-author",
    appLogin: "the-app[bot]",
    runUrl: "https://example.test/run",
    run,
    ask: () => Promise.reject(new Error("no model is asked")),
  };

  return { env, calls };
}

export type LabelEvent = (typeof IssueEvents.Type)[number];

export const labeled = (name: string, login: string | null, createdAt: string): LabelEvent => ({
  event: "labeled",
  label: { name },
  actor: login === null ? null : { login },
  created_at: createdAt,
});

// An inherited GIT_DIR would point a fixture's git at the real repository; the test layer cannot import fixtureEnv.
// A fixture's commit is not signed: in a Worker's sandbox the signing key is out of reach.
export const FIXTURE_ENV = {
  ...Object.fromEntries(
    Object.entries(process.env).flatMap(([name, value]) =>
      name.startsWith("GIT_") || value === undefined ? [] : [[name, value] as const],
    ),
  ),
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "commit.gpgsign",
  GIT_CONFIG_VALUE_0: "false",
};

/** A new git repository, and a git that runs in it. */
export async function fixtureRepo(prefix: string) {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  const env = FIXTURE_ENV;

  const git = (args: readonly string[]) => $`git ${args}`.cwd(repo).env(env).quiet();

  await git(["init", "-q"]);
  await git(["config", "user.email", "t@t"]);
  await git(["config", "user.name", "t"]);

  return { repo, git };
}

export type CheckRun = (typeof CheckRuns.Type)["check_runs"][number];

export const runIn = (suite: number, status: string, conclusion: string | null, slug = "github-actions"): CheckRun => ({
  name: "x",
  status,
  conclusion,
  app: { slug },
  check_suite: { id: suite },
});
