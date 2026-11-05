export interface Task {
  readonly id: number;
  readonly title: string;
  readonly done: boolean;
  readonly createdAt?: string;
}

export class TaskError extends Error {}

const MAX_TITLE_LENGTH = 200;

/** Returns the title trimmed. Refuses a blank title or one over the length limit. */
export function cleanTitle(title: string): string {
  const trimmed = title.trim();

  if (trimmed === "") throw new TaskError("a task needs a title");

  if ([...trimmed].length > MAX_TITLE_LENGTH) {
    throw new TaskError(`a title takes at most ${MAX_TITLE_LENGTH} characters`);
  }

  return trimmed;
}
