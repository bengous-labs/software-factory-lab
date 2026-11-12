/**
 * The vocabulary of a finding, which the review job reports, the Merge bot posts and counts, and the
 * Stop hook and the relay read back: its severity, and how a posted one reads from its thread.
 */

import { Schema } from "effect";

export const Severity = Schema.Literals(["important", "nit", "pre_existing"]);

export type Severity = typeof Severity.Type;

/** An unresolved Important thread of the App: its id, and the patch and round of the review that posted it, null when its review names none. */
export interface ImportantThread {
  readonly thread: string;
  readonly review: { readonly patch: string; readonly round: number } | null;
}

/** A posted finding, as a round's count reads it: its severity, and whether the security pass reported it. */
export interface Counted {
  readonly severity: "important" | "nit";
  readonly security: boolean;
}

export const SEVERITY_NAME: Readonly<Record<Counted["severity"], string>> = { important: "Important", nit: "Nit" };

/**
 * What a round posted, in plain words: `2 Important (1 security), 5 Nit (2 security)`. A severity it
 * posted none of is left out, and a round that posted none says so.
 */
export function postedCountOf(findings: readonly Counted[]): string {
  const counts = (["important", "nit"] as const).flatMap((severity) => {
    const posted = findings.filter((finding) => finding.severity === severity);
    const security = posted.filter((finding) => finding.security).length;
    const pass = security === 0 ? "" : ` (${security} security)`;

    return posted.length === 0 ? [] : [`${posted.length} ${SEVERITY_NAME[severity]}${pass}`];
  });

  return counts.length === 0 ? "no new finding" : counts.join(", ");
}

/** A finding the App posted, as the ledger reads its thread (`findings.ts`, `ledgerFindingsOf`). */
export interface LedgerFinding extends Counted {
  readonly thread: string;
  /** The finding's comment on GitHub. */
  readonly url: string;
  /** `<file>:<line>` of the line its thread is anchored on, or `<file>`. */
  readonly where: string;
  /** The file the finding is about, the one its comment names when it anchors on another. */
  readonly file: string;
  /** Its first line, without its label. */
  readonly summary: string;
  /** The Review round that posted it. */
  readonly round: number;
  readonly resolved: boolean;
  /** The App resolved its thread: a later read left it out, or the Owner's Land approval closed it. */
  readonly closedByApp: boolean;
  /** The App's reply in its thread says the Owner's Land approval landed it open (`LANDED_OPEN_MARKER`). */
  readonly landedOpen: boolean;
  /** GitHub marks its thread outdated: the lines it is anchored on changed since. */
  readonly outdated: boolean;
  /** The Author's rejection reply, the resolved thread's latest answer; null when the Author did not reject it. */
  readonly rejection: string | null;
  /** The Owner's reply, the thread's latest answer, written by hand; null when the latest answer is none of the Owner's. */
  readonly ownerAnswer: string | null;
  /** The later reads that report it again in its thread: each a Review round, or a Delta read (DELTA_READ). */
  readonly again: readonly number[];
}
