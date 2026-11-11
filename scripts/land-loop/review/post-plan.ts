/**
 * The review the Merge bot posts from the review job's report: one inline comment per posted finding,
 * each with its thread, anchored on a line GitHub accepts, and a body that counts them and carries the
 * marker a later decision reads to post the review only once. A Pre-existing finding is not posted. A
 * security pass's finding names its pass after its severity, and keeps the severity's marker.
 */

import type { Schema } from "effect";

import { codeSpan, escapeHtml, escapeInline } from "../../lib/markdown.ts";
import { DELTA_READ, postedCountOf, reviewNameOf, roundNameOf } from "../merge-bot/decide.ts";
import { markerOf, movedLineOf } from "./findings.ts";
import type { ReviewThread } from "./findings.ts";
import type { ReportedFinding, ReportedResult, ReviewRequest, Severity } from "./review-report.ts";

/** The RIGHT-side lines of each hunk of the PR's whole diff, context included: GitHub accepts an inline comment only there. */
export type DiffLines = ReadonlyMap<string, ReadonlySet<number>>;

interface Anchor {
  readonly file: string;
  readonly line: number;
}

type PostedSeverity = Exclude<Severity, "pre_existing">;

/** One inline comment to post: where it anchors on the diff, and the finding it carries. */
interface PlannedComment {
  readonly anchor: Anchor;
  readonly finding: ReportedFinding;
  readonly severity: PostedSeverity;
}

export interface PostPlan {
  /** One inline comment per finding that is posted, each with its thread. */
  readonly comments: readonly PlannedComment[];
  /** Pre-existing findings: not posted, only counted. */
  readonly preExisting: number;
}

/** The cap on Nits per review that REVIEW.md sets, applied to each pass of a review: the Code review's and the security pass's. */
const NIT_CAP = 3;

/** The header of a file's new side; `/dev/null`, a deleted file's, does not start so. */
const NEW_FILE = "+++ b/";

const HUNK = /^@@ -\S+ \+(\d+)/u;

/**
 * The `git` arguments of the diff `diffLinesOf` reads: the PR's whole range, with unquoted paths, since
 * git quotes a non-ASCII path by default and `diffLinesOf` reads `+++ b/<path>` as it stands.
 */
export function diffArgsOf(base: string, head: string): readonly string[] {
  return ["-c", "core.quotePath=false", "diff", `${base}..${head}`];
}

/**
 * The lines of the new side each hunk of `diff`, a `git diff` with its `a/` and `b/` prefixes, shows:
 * added and context lines. Git ends a path that holds a space with a tab.
 */
export function diffLinesOf(diff: string): DiffLines {
  const lines = new Map<string, Set<number>>();
  let file = "";
  let next = 0;
  let inHunks = false;

  for (const row of diff.split("\n")) {
    const hunk = HUNK.exec(row);

    if (row.startsWith("diff --git ")) {
      inHunks = false;
    } else if (!inHunks && row.startsWith(NEW_FILE)) {
      file = row.slice(NEW_FILE.length).trimEnd();
    } else if (hunk !== null) {
      inHunks = true;
      next = Number(hunk[1]);
    } else if (inHunks && (row.startsWith(" ") || row.startsWith("+"))) {
      lines.set(file, (lines.get(file) ?? new Set()).add(next));
      next += 1;
    }
  }

  return lines;
}

/** No line of a diff: GitHub numbers lines from 1. */
const NO_LINE = 0;

/**
 * Where a finding anchors: its own line when the diff shows it, else the first line the diff shows of
 * its file, else the first line of the diff. A diff that shows no line at all leaves none to anchor on.
 */
function anchorOf(finding: ReportedFinding, diff: DiffLines): Anchor {
  const own = diff.get(finding.file);
  const line = finding.line ?? NO_LINE;

  if (own !== undefined) {
    return { file: finding.file, line: own.has(line) ? line : Math.min(...own) };
  }

  const [first] = diff;

  if (first === undefined) {
    throw new Error(`the finding on ${finding.file} has no line of the diff to anchor on`);
  }

  return { file: first[0], line: Math.min(...first[1]) };
}

/**
 * The comments to post: every Important, and each pass's first Nits up to the cap; a diff that shows no
 * line throws.
 */
export function postPlanOf(findings: readonly ReportedFinding[], diff: DiffLines): PostPlan {
  const planned = (severity: PostedSeverity, passes: ReadonlyArray<ReportedFinding["pass"]>): PlannedComment[] =>
    findings.flatMap((finding) =>
      finding.severity === severity && passes.includes(finding.pass)
        ? [{ anchor: anchorOf(finding, diff), finding, severity }]
        : [],
    );

  return {
    comments: [
      ...planned("important", ["code", "security"]),
      ...planned("nit", ["code"]).slice(0, NIT_CAP),
      ...planned("nit", ["security"]).slice(0, NIT_CAP),
    ],
    preExisting: findings.filter((finding) => finding.severity === "pre_existing").length,
  };
}

const LABEL: Readonly<Record<PostedSeverity, string>> = { important: "Important", nit: "Nit" };

const labelOf = ({ severity, finding }: PlannedComment): string =>
  finding.pass === "security" ? `${LABEL[severity]} (security)` : LABEL[severity];

const placeOf = (place: { readonly file: string; readonly line: number | null }): string =>
  place.line === null ? place.file : `${place.file}:${place.line}`;

/** A finding's comment: its severity and summary, the true place when it anchors elsewhere, where it breaks, and the marker. */
function commentOf(planned: PlannedComment): string {
  const { anchor, finding } = planned;
  // A finding with no line on a file of the diff anchors on that file's first line: it has not moved.
  const moved = anchor.file !== finding.file || (finding.line !== null && anchor.line !== finding.line);

  return [
    `**${labelOf(planned)}**: ${escapeInline(finding.summary)}`,
    ...(moved ? [movedLineOf(placeOf(finding))] : []),
    ...(finding.breaks === null ? [] : [`Breaks: ${codeSpan(placeOf(finding.breaks))}`]),
    "",
    escapeHtml(finding.failureScenario),
    "",
    markerOf(planned.severity),
  ].join("\n");
}

/** The marker of the review of `request`'s patch and round. An external name: posted reviews carry it, so the string stays. */
export function reviewMarkerOf(request: ReviewRequest): string {
  return `<!-- lab-review patch=${request.patch} round=${request.round} -->`;
}

/** A reply the Merge bot posts in the open thread of an earlier Important that a later round reports again. */
export interface AgainReply {
  readonly thread: string;
  readonly body: string;
}

/**
 * The replies that carry, each in its open thread of `heldOpen`, the Importants the round of `result`
 * reports again: what is still wrong, under the finding's marker, so the relay delivers it to the
 * Author, and under the review's marker, so a posting that is retried posts none twice. A thread takes
 * one reply per review, with every finding of the round that names it, the Code review's and the
 * security pass's. Only a comment of the App counts as that reply: `appLogin` is its login as GraphQL
 * prints it, and any login can write the marker.
 */
export function againRepliesOf(
  result: ReportedResult,
  heldOpen: readonly string[],
  threads: readonly ReviewThread[],
  appLogin: string,
): AgainReply[] {
  const { request } = result;
  const marker = reviewMarkerOf(request);

  return heldOpen.flatMap((thread) => {
    const posted = threads.some(
      (found) =>
        found.id === thread &&
        found.comments.nodes.some((comment) => comment.author?.login === appLogin && comment.body.includes(marker)),
    );

    const again = result.report.findings.filter(
      (finding) => finding.severity === "important" && finding.earlier === thread,
    );

    if (posted || again.length === 0) {
      return [];
    }

    const reports = again.flatMap((finding) => [
      `**${finding.pass === "security" ? `${LABEL.important} (security)` : LABEL.important}**: ${escapeInline(finding.summary)}`,
      "",
      escapeHtml(finding.failureScenario),
      "",
    ]);

    const body = [
      `${request.round === DELTA_READ ? "The Delta read" : reviewNameOf(request.round)} still holds this finding.`,
      "",
      ...reports,
      markerOf("important"),
      marker,
    ].join("\n");

    return [{ thread, body }];
  });
}

/**
 * The review's body: its summary line, what the round or the Delta read posted in plain words with the
 * security pass's share of each severity and the Pre-existing findings it did not post, then the run that
 * read it.
 */
function bodyOf(plan: PostPlan, result: ReportedResult): string {
  const { request } = result;

  const posted = postedCountOf(
    plan.comments.map((planned) => ({ severity: planned.severity, security: planned.finding.pass === "security" })),
  );

  const defects = plan.preExisting === 1 ? "defect" : "defects";
  const preExisting = plan.preExisting === 0 ? "" : ` ${plan.preExisting} pre-existing ${defects} not posted.`;

  return [
    `${roundNameOf(request.round)}: ${posted}.${preExisting}`,
    "",
    `Review run (${result.model ?? request.model}, /code-review ${request.effort}): ${result.runUrl}`,
    "",
    reviewMarkerOf(request),
  ].join("\n");
}

/** The body of `POST pulls/<n>/reviews` for `plan`, on `commit`: one comment on the new side per planned comment. */
export function reviewOf(plan: PostPlan, result: ReportedResult, commit: string): Schema.JsonObject {
  return {
    commit_id: commit,
    event: "COMMENT",
    body: bodyOf(plan, result),
    comments: plan.comments.map((planned) => ({
      path: planned.anchor.file,
      line: planned.anchor.line,
      side: "RIGHT",
      body: commentOf(planned),
    })),
  };
}
