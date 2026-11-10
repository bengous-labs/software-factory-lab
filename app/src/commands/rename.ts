import { cleanTitle, TaskError } from "../task.ts";
import type { Task } from "../task.ts";

export function rename(tasks: readonly Task[], id: number, title: string): readonly Task[] {
  const trimmed = cleanTitle(title);

  if (!tasks.some((task) => task.id === id)) {
    throw new TaskError(`no task #${id}`);
  }

  for (const item of tasks) {
    if (item.id === id && item.title === trimmed) {
      throw new TaskError(`task #${id} already has that title`);
    }
  }

  return tasks.map((task) => (task.id === id ? { ...task, title: trimmed } : task));
}
