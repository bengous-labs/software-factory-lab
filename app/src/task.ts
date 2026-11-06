import { Schema } from "effect";

/** When a task was added, as `Date.prototype.toISOString` writes it. */
export const CreatedAt = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u, { expected: "an ISO timestamp" }),
);

export const Task = Schema.Struct({
  id: Schema.Number,
  title: Schema.String,
  done: Schema.Boolean,
  createdAt: Schema.optionalKey(CreatedAt),
});

export type Task = typeof Task.Type;

export class TaskError extends Error {}

const MAX_TITLE_LENGTH = 200;

/** Returns the title trimmed. Refuses a blank title or one over the length limit. */
export function cleanTitle(title: string): string {
  const trimmed = title.trim();

  if (trimmed === "") {
    throw new TaskError("a task needs a title");
  }

  if (Array.from(trimmed).length > MAX_TITLE_LENGTH) {
    throw new TaskError(`a title takes at most ${MAX_TITLE_LENGTH} characters`);
  }

  return trimmed;
}
