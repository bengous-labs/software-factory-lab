/**
 * Preloaded by the run of the mutation set's tests in `scripts/ci/no-process.test.ts`: each way Bun and
 * `node:child_process` start a process throws instead, naming itself, and prints a line that starts with
 * `no-process:`, which the run fails on even when the code under test catches the throw. A test that starts
 * a process takes its time from the machine's load: under Stryker's parallel runs it can pass `bun test`'s
 * limit, and a test that times out kills a mutant no assertion checked.
 *
 * A `Worker` a test starts loads no preload, and nothing here refuses a start in it: wrapping `Worker` to
 * pass it this file is what `local/layers` refuses, with no suppression.
 */

// Taken as the preload loads: a test that mutes `console.error` later cannot hide a refusal. Bun writes it in
// order with its own report, where `process.stderr` would put it ahead of its test file's name.
const report = console.error.bind(console);

const refusal =
  (name: string, does = "starts a process") =>
  (): never => {
    const message = `${name} ${does} in a test of the mutation set. A test that does is a \`x.live.test.ts\`, which the mutation job does not run.`;
    report(`no-process: ${message}`);

    throw new Error(message);
  };

// `bun:ffi`, which `local/layers` refuses in every layer, is `Bun.FFI` too, which bun-types does not declare:
// a native symbol it makes callable, libc's `system` or `fork`, starts a process.
const NATIVE = "calls native code, which can start a process,";

Object.assign(Bun, {
  spawn: refusal("Bun.spawn"),
  spawnSync: refusal("Bun.spawnSync"),
  $: refusal("Bun.$"),
  FFI: Object.fromEntries(
    ["dlopen", "linkSymbols", "cfunction"].map((name) => [name, refusal(`Bun.FFI.${name}`, NATIVE)]),
  ),
});

// Each start of `node:child_process` reaches Bun's, whose refusal its line already fails the run on; the
// patch names it by its own API, and makes its `spawnSync` throw, where it would return Bun's refusal as
// `error`. Patched before any `import` of it: an ESM import takes its named exports from the module as it is then.
Object.assign(
  process.getBuiltinModule("node:child_process"),
  Object.fromEntries(
    ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"].map((name) => [
      name,
      refusal(`child_process.${name}`),
    ]),
  ),
);
