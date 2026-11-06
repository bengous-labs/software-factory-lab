import { cleanTitle, TaskError } from "../task.ts";
import type { Task } from "../task.ts";

export function rename(tasks: readonly Task[], id: number, title: string): readonly Task[] {
  const cleaned = cleanTitle(title);

  if (!tasks.some((task) => task.id === id)) {
    throw new TaskError(`no task #${id}`);
  }

  return tasks.map((task) => (task.id === id ? { ...task, title: cleaned } : task));
}
