import type { Ran, Run, RunOptions } from "./run.port.ts";

export const run: Run = (argv, options) => spawned(argv, options, { ...process.env, ...options.env });

/** Like `run`, but `options.env` is the child's whole environment: nothing of this process's reaches it. */
export const runIsolated: Run = (argv, options) => spawned(argv, options, { ...options.env });

async function spawned(
  argv: readonly string[],
  options: RunOptions,
  env: Readonly<Record<string, string | undefined>>,
): Promise<Ran> {
  const child = Bun.spawn([...argv], {
    cwd: options.cwd,
    env,
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
}
