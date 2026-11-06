export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly stdin?: string;
}

/** Runs `argv` to its end and returns its exit code and output; a timeout kills it and reads code 124. */
export type Run = (argv: readonly string[], options: RunOptions) => Promise<Ran>;
