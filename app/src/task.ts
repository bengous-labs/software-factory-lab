export interface Task {
  readonly id: number;
  readonly title: string;
  readonly done: boolean;
}

export class TaskError extends Error {}
