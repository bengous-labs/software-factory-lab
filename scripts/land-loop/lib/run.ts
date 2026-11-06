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

export const run: Run = async (argv, options) => {
  const child = Bun.spawn([...argv], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = { fired: false };

  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timeout.fired = true;
          child.kill();
        }, options.timeoutMs);

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  clearTimeout(timer);

  return { code: timeout.fired ? 124 : code, stdout, stderr };
};

/** Like `run`, but anything other than exit 0 throws with what the command printed. */
export async function checked(runner: Run, argv: readonly string[], options: RunOptions): Promise<string> {
  const ran = await runner(argv, options);

  if (ran.code !== 0) {
    throw new Error(`${argv.slice(0, 3).join(" ")} exited ${ran.code}: ${(ran.stderr || ran.stdout).trim()}`);
  }

  return ran.stdout;
}
