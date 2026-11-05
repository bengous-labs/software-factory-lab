import { type Task, TaskError } from "../task.ts";

export function add(tasks: readonly Task[], title: string): readonly Task[] {
  const trimmed = title.trim();

  if (trimmed === "") throw new TaskError("a task needs a title");

  const id = tasks.reduce((max, task) => Math.max(max, task.id), 0) + 1;

  return [...tasks, { id, title: trimmed, done: false }];
}
