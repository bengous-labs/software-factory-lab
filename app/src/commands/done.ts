import { TaskError } from "../task.ts";
import type { Task } from "../task.ts";

export function done(tasks: readonly Task[], id: number): readonly Task[] {
  if (!tasks.some((task) => task.id === id)) {
    throw new TaskError(`no task #${id}`);
  }

  return tasks.map((task) => (task.id === id ? { ...task, done: true } : task));
}
