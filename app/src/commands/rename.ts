import { cleanTitle, TaskError } from "../task.ts";
import type { Task } from "../task.ts";

export function rename(tasks: readonly Task[], id: number, title: string): readonly Task[] {
  const trimmed = cleanTitle(title);

  const current = tasks.find((task) => task.id === id);

  if (current === undefined) {
    throw new TaskError(`no task #${id}`);
  }

  if (current.title === trimmed) {
    throw new TaskError(`task #${id} already has that title`);
  }

  return tasks.map((task) => (task.id === id ? { ...task, title: trimmed } : task));
}
