import { type Task, TaskError } from "../task.ts";

export function undone(tasks: readonly Task[], id: number): readonly Task[] {
  if (!tasks.some((task) => task.id === id)) throw new TaskError(`no task #${id}`);

  return tasks.map((task) => (task.id === id ? { ...task, done: false } : task));
}
