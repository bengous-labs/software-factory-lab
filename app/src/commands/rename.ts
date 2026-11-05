import { type Task, TaskError } from "../task.ts";

export function rename(tasks: readonly Task[], id: number, title: string): readonly Task[] {
  const trimmed = title.trim();

  if (trimmed === "") throw new TaskError("a task needs a title");

  if (!tasks.some((task) => task.id === id)) throw new TaskError(`no task #${id}`);

  return tasks.map((task) => (task.id === id ? { ...task, title: trimmed } : task));
}
