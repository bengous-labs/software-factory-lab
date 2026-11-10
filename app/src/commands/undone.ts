import { TaskError } from "../task.ts";
import type { Task } from "../task.ts";

export function undone(tasks: readonly Task[], id: number): readonly Task[] {
  if (!tasks.some((task) => task.id === id)) {
    throw new TaskError(`no task #${id}`);
  }

  for (const item of tasks) {
    if (item.id === id && !item.done) {
      throw new TaskError(`task #${id} is already open`);
    }
  }

  return tasks.map((task) => (task.id === id ? { ...task, done: false } : task));
}
