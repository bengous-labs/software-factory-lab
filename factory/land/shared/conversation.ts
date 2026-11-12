/** A pull request's conversation, as the Stop hook and the relay read it with `gh`: its comments, in their order. */

import { Schema } from "effect";

import { decodeJson } from "../../lib/json.ts";

/** A comment of the PR's conversation: the id an edit names, its author's login as GraphQL prints it, and its body. */
export interface ConversationComment {
  readonly id: string;
  readonly author: string;
  readonly body: string;
}

/** One conversation comment as the `--jq` filter of `conversationArgsOf` prints it; a deleted user's has a null author. */
const PrintedComment = Schema.Struct({
  id: Schema.String,
  author: Schema.NullOr(Schema.String),
  body: Schema.String,
});

/** The `gh` command that prints the conversation comments of PR `pr`, one JSON line each, for `conversationOf`. */
export function conversationArgsOf(pr: number): readonly string[] {
  return [
    "gh",
    "api",
    "--paginate",
    `repos/{owner}/{repo}/issues/${pr}/comments?per_page=100`,
    "--jq",
    ".[] | {id: (.id | tostring), author: .user.login, body}",
  ];
}

/** A PR's conversation comments, from the lines `conversationArgsOf` prints. */
export function conversationOf(conversation: string): readonly ConversationComment[] {
  return conversation
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const comment = decodeJson(PrintedComment, "a conversation comment", line);

      return { ...comment, author: comment.author?.replace(/\[bot\]$/u, "") ?? "unknown" };
    });
}
