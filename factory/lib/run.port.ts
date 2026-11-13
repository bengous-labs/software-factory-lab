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

/** Runs `argv` through `runner`; anything other than exit 0 throws with what the command printed. */
export async function checked(runner: Run, argv: readonly string[], options: RunOptions): Promise<string> {
  const ran = await runner(argv, options);

  if (ran.code !== 0) {
    throw new Error(`${argv.slice(0, 3).join(" ")} exited ${ran.code}: ${(ran.stderr || ran.stdout).trim()}`);
  }

  return ran.stdout;
}

export interface LeaveOptions {
  readonly cwd: string;
  /** The child's whole environment. */
  readonly env: Readonly<Record<string, string>>;
  /** The file its output is appended to, created for its owner alone; its directory is created. */
  readonly log: string;
}

/** A process left running. */
interface Left {
  readonly pid: number;
  /** Its exit code once it ends, 1 when a signal ended it. It does not keep this process alive. */
  readonly exited: Promise<number>;
}

/** Leaves `argv` running detached, so it outlives this process. */
export type Leave = (argv: readonly string[], options: LeaveOptions) => Left;
