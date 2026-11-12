/**
 * The texts the Stop hook puts to a fork of the Author's session: the Done judge's question, with the
 * App's open findings on the pull request, and the request for the pull request's title and body.
 */

import { FORK_MARKER } from "./decide.ts";

/** An open finding of the App, as the Done judge's question lists it. */
export interface AskedFinding {
  /** The id of the finding's review thread, which a rejection or a fix names. */
  readonly thread: string;
  /** `<file>` or `<file>:<line>`. */
  readonly where: string;
  readonly severity: "important" | "nit";
  /** The finding's first line. */
  readonly summary: string;
}

const SEVERITY: Readonly<Record<AskedFinding["severity"], string>> = { important: "Important", nit: "Nit" };

const QUESTION = `${FORK_MARKER} Stop hook question, not the Owner's: is your current change finished and committed, and does your last message before this question leave a question or a choice to your user? Publishing the branch and watching the pull request are the Land loop's job, not part of this answer.`;

const ANSWER = [
  "Answer in the structured output:",
  "- finished: true when the change is finished and committed, false otherwise.",
  "- question: the question or choice your last message puts to your user, quoted; an empty string when it puts none. A choice you offered stays open even where you recommended one option or acted on it for now: only your user's answer settles it.",
  "- reason: one sentence.",
  "- rejections: the open review findings listed below that you decided not to fix, each with the id of its thread and your own reason, as you gave it in this conversation. Declare a rejection only where you had decided, before this question, not to fix the finding. A finding you fixed, or one you have not decided on, is no rejection: leave it out. A reason never cites a commit.",
  "- fixed: the ids of the threads of the open review findings listed below that your committed change fixed, as this conversation shows. A finding you rejected, left as it is, or have not decided on, is not fixed: leave it out.",
];

/** The Done judge's question, with the App's open findings on the Author's pull request, when it has one. */
export function doneQuestionOf(findings: readonly AskedFinding[]): string {
  const listed =
    findings.length === 0
      ? ["Your pull request has no open review finding: answer `rejections` and `fixed` with empty lists."]
      : [
          "The open review findings on your pull request:",
          ...findings.map(
            (finding) => `- ${finding.thread} on ${finding.where} (${SEVERITY[finding.severity]}): ${finding.summary}`,
          ),
        ];

  return [QUESTION, "", ...ANSWER, "", ...listed].join("\n");
}

export const BODY_REQUEST = `${FORK_MARKER} Stop hook request, not the Owner's: write the pull request for the commits on this branch. First line: its title, as a conventional commit subject. Then a blank line, then its body in Markdown: what changed and why, and how you verified it. Print nothing else.`;
