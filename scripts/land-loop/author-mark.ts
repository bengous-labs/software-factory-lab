/**
 * The marks the Stop hook writes on what it posts for the Author, and what reads them back: the Merge
 * bot, the relay and the watch tell the Author's replies, its question to the Owner and the findings it
 * says it fixed from any other comment. The lab is public: any login can write a mark, so each reader
 * also checks who wrote the comment.
 */

import { AUTHOR_LOGIN, OWNER_LOGIN } from "./logins.ts";

/** Marks a reply as posted for the Author, so the relay of the Author's PR does not deliver it back. */
export const AUTHOR_MARK = "<!-- lab-author-reply -->";

/** Marks the comment that puts the Author's question to the Owner, so a later stop does not post it again. */
export const QUESTION_MARK = "<!-- lab-author-question -->";

/** Marks the author's reply as a rejection of the finding, so the Review check counts it apart from a fix. */
export const REJECT_MARK = "<!-- lab-author-reject -->";

/** Opens the hidden list, in the Stop hook's one comment on a PR, of the findings the Author says it fixed. */
export const FIXED_MARK = "<!-- lab-author-fixed";

/** A comment on a PR, by its author's login. */
export interface PrComment {
  readonly author: string;
  readonly body: string;
}

/**
 * The fixed list: a line of its own, as the record writes it. The hook's questions to the Owner quote
 * each line after `> `, so a mark they quote, in a code span or a fenced block, is never a line of its
 * own. A comment the Worker posts itself with the Author's token, the mark on a line of its own, is
 * taken for the record: its list is the Author's word too, which only the ledger shows.
 */
const FIXED_LIST = new RegExp(`(?<=^|\\n)${FIXED_MARK}((?: [^\\s>]+)*) -->(?=\\n|$)`, "u");

/** The threads the fixed list of `body` names; null when `body` holds no such list on a line of its own. */
export function fixedListOf(body: string): readonly string[] | null {
  const listed = FIXED_LIST.exec(body)?.[1];

  return listed === undefined ? null : listed.split(" ").filter((thread) => thread !== "");
}

/**
 * Whether the Owner wrote these words by hand. The lab is public and any GitHub login can comment on a
 * pull request: of a person's words, the Land loop reads the Owner's alone, never another login's, which
 * would reach the Author's session as a turn to act on.
 */
export const byOwner = (comment: PrComment): boolean =>
  comment.author === OWNER_LOGIN && !comment.body.includes(AUTHOR_MARK);

/**
 * The question of the Author the Owner has not answered among the PR's conversation `comments`, in
 * their order: the last comment the hook posted with the question mark, when no comment of the Owner
 * follows it; else null.
 */
export function openQuestionOf<C extends PrComment>(comments: readonly C[]): C | null {
  const asked = comments.findLastIndex(
    (comment) => comment.author === AUTHOR_LOGIN && comment.body.includes(QUESTION_MARK),
  );

  const question = comments[asked];

  return question === undefined || comments.slice(asked + 1).some((comment) => byOwner(comment)) ? null : question;
}

/** Whether the PR's conversation `comments`, in their order, hold a question of the Author the Owner has not answered. */
export const questionOpen = (comments: readonly PrComment[]): boolean => openQuestionOf(comments) !== null;
