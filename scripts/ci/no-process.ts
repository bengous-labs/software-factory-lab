/**
 * Preloaded by the run of the mutation set's tests in `scripts/ci/no-process.test.ts`: each way Bun and
 * `node:child_process` start a process throws instead, naming itself, and prints a line that starts with
 * `no-process:`, which the run fails on even when the code under test catches the throw. A test that starts
 * a process takes its time from the machine's load: under Stryker's parallel runs it can pass `bun test`'s
 * limit, and a test that times out kills a mutant no assertion checked.
 */

const refusal = (name: string) => (): never => {
  const message = `${name} starts a process in a test of the mutation set. A test that starts one is a \`x.live.test.ts\`, which the mutation job does not run.`;
  console.error(`no-process: ${message}`);

  throw new Error(message);
};

Object.assign(Bun, { spawn: refusal("Bun.spawn"), spawnSync: refusal("Bun.spawnSync"), $: refusal("Bun.$") });

// Patched before any `import` of it: an ESM import takes its named exports from the module as it is then.
// Its `spawnSync` would otherwise catch Bun's refusal and return it as `error`, starting nothing and failing nothing.
Object.assign(
  process.getBuiltinModule("node:child_process"),
  Object.fromEntries(
    ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"].map((name) => [
      name,
      refusal(`child_process.${name}`),
    ]),
  ),
);
