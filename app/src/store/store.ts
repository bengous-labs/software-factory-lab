import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { type Task, TaskError } from "../task.ts";

/** The version of the file format; a file of another version is refused, never guessed at. */
export const FORMAT_VERSION = 1;

interface StoreFile {
  readonly version: number;
  readonly tasks: readonly Task[];
}

function isTask(value: unknown): value is Task {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;

  return (
    typeof record["id"] === "number" &&
    typeof record["title"] === "string" &&
    typeof record["done"] === "boolean"
  );
}

export function parse(text: string, path: string): readonly Task[] {
  const data: unknown = JSON.parse(text);

  if (typeof data !== "object" || data === null) throw new TaskError(`${path}: not an object`);

  const file = data as Partial<StoreFile>;

  if (file.version !== FORMAT_VERSION) {
    throw new TaskError(`${path}: format version ${String(file.version)}, expected ${FORMAT_VERSION}`);
  }

  if (!Array.isArray(file.tasks) || !file.tasks.every(isTask)) {
    throw new TaskError(`${path}: tasks is not a list of tasks`);
  }

  return file.tasks;
}

export function serialize(tasks: readonly Task[]): string {
  const file: StoreFile = { version: FORMAT_VERSION, tasks };

  return `${JSON.stringify(file, null, 2)}\n`;
}

export function load(path: string): readonly Task[] {
  return existsSync(path) ? parse(readFileSync(path, "utf8"), path) : [];
}

export function save(path: string, tasks: readonly Task[]): void {
  writeFileSync(path, serialize(tasks));
}
