#!/usr/bin/env bun

/**
 * The sandbox probe: shows on this machine that the sandbox of a Worker holds, and that a Worker still
 * works in it. It writes canary files where credentials live, never reading a real one, and runs two
 * headless sessions at `HEAD`, each where a Worker works, in a clone of its own under the clones'
 * directory: one on the sandbox alone, and one on a background Worker's settings, the main checkout's
 * hooks included. They make the probes `factory/dispatch/probe-plan.ts` lists. It prints
 * every path it writes before it writes one, and removes them all at its end, on a failure too, but each
 * session's output, which it keeps in the ignored `.lab/sandbox-probe/` of its own checkout. It bills
 * the Owner's login for two short sessions on the smallest model. The Owner runs it, never a Worker: it
 * writes in the home.
 *
 *   bun factory/bin/sandbox-probe.ts
 *
 * It prints one line per probe, then `sandbox-probe: <k>/<n> as expected`, and exits 1 unless k is n.
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { cloneArgvOf, projectSettingsOf, workerSettingsOf } from "../dispatch/dispatch-plan.ts";
import {
  canariesOf,
  canaryContentOf,
  layoutOf,
  probeSettingsOf,
  probesOf,
  promptOf,
  reportOf,
  scriptOf,
  sessionArgvOf,
  SESSIONS,
  socketCandidatesOf,
  userAllowWriteOf,
  writtenPathsOf,
} from "../dispatch/probe-plan.ts";
import type { CommandResult, ProbeFacts, SessionRun } from "../dispatch/probe-plan.ts";
import { PROBED_CREDENTIAL_DIRS, USER_SETTINGS } from "../install/sandbox-paths.ts";
import { sandboxPlaceProblemOf } from "../land/shared/worker-sandbox.ts";
import { requiredOf } from "../lib/env.ts";
import { runIsolated } from "../lib/run.live.ts";
import { sessionEnvOf } from "../lib/session-env.ts";

/** How long one session may take: it installs its tree's dependencies and runs `bun check`. */
const SESSION_TIMEOUT_MS = 2_700_000;

/** What `git` prints for `args`, run in this file's checkout; throws when git fails. */
function git(...args: string[]): string {
  const ran = Bun.spawnSync(["git", ...args], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });

  if (ran.exitCode !== 0) {
    throw new Error(`git ${args.slice(0, 2).join(" ")} exited ${ran.exitCode}: ${ran.stderr.toString().trim()}`);
  }

  return ran.stdout.toString().trim();
}

const isDirectory = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

/** What the machine holds: which probed directories and sockets exist, and what the Owner's own settings let a command write. */
function factsOf(home: string, checkout: string): ProbeFacts {
  const userSettings = join(home, USER_SETTINGS);
  const runtimeDir = process.env["XDG_RUNTIME_DIR"] ?? null;

  return {
    place: { home, checkout },
    token: `canary-${randomBytes(16).toString("hex")}`,
    credentialDirs: PROBED_CREDENTIAL_DIRS.filter((dir) => isDirectory(join(home, dir))),
    sockets: runtimeDir === null ? [] : socketCandidatesOf(runtimeDir).filter((socket) => existsSync(socket.path)),
    runtimeDir,
    userAllowWrite: userAllowWriteOf(
      existsSync(userSettings) ? readFileSync(userSettings, "utf8") : null,
      home,
      dirname(userSettings),
    ).filter((dir) => isDirectory(dir)),
  };
}

/** What the command probes of a session recorded under `dir`, by probe id. */
function resultsIn(dir: string): Map<string, CommandResult> {
  const names = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".code")) : [];

  return new Map(
    names.map((name) => {
      const id = name.slice(0, -".code".length);
      const out = join(dir, `${id}.out`);

      return [
        id,
        {
          code: Number(readFileSync(join(dir, name), "utf8").trim()),
          output: existsSync(out) ? readFileSync(out, "utf8") : "",
        },
      ];
    }),
  );
}

const home = requiredOf(process.env, "HOME");

const facts = factsOf(home, dirname(git("rev-parse", "--path-format=absolute", "--git-common-dir")));

const problem = sandboxPlaceProblemOf(facts.place);

if (problem !== null) {
  throw new Error(`no Worker can be sandboxed here: ${problem}`);
}

const layouts = { api: layoutOf(facts, "api"), background: layoutOf(facts, "background") };

const canaries = canariesOf(facts);

const taken = [
  ...canaries.map((canary) => canary.path),
  layouts.api.tree,
  layouts.background.tree,
  ...layouts.background.touched,
].filter((path) => existsSync(path));

if (taken.length > 0) {
  throw new Error(`sandbox-probe: these paths exist already, and the probe overwrites nothing: ${taken.join(", ")}`);
}

// Read before anything is written: a Worker settings file that does not read leaves nothing behind.
const settings = probeSettingsOf(
  readFileSync(workerSettingsOf(home), "utf8"),
  readFileSync(projectSettingsOf(facts.place.checkout), "utf8"),
  facts.place,
);

console.log(
  `sandbox-probe writes these, then removes them:\n${writtenPathsOf(facts)
    .map((path) => `  ${path}`)
    .join("\n")}`,
);

/** The files this run wrote outside the sessions' trees. */
const writtenFiles: string[] = [];

/** The clones this run created, one per session. */
const clonesCreated: string[] = [];

/** Removes what this run wrote, and what a probe would have written where the sandbox did not hold; a removal that fails is said, and stops no other. */
function cleanUp(): void {
  for (const path of [...writtenFiles.splice(0), ...layouts.background.touched]) {
    try {
      rmSync(path, { force: true });
    } catch (error) {
      console.error(`sandbox-probe: ${path} is left: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const tree of clonesCreated.splice(0)) {
    try {
      rmSync(tree, { recursive: true, force: true });
    } catch (error) {
      console.error(
        `sandbox-probe: the clone ${tree} is left: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    cleanUp();
    // oxlint-disable-next-line unicorn/no-process-exit -- a signal ends the probe here, once what it wrote is removed: no caller is left to return to.
    process.exit(130);
  });
}

/** Writes `text` to a new file at `path`, for its owner alone, and notes it for the removal. */
function writeOwn(path: string, text: string): void {
  rmSync(path, { force: true });
  writtenFiles.push(path);
  writeFileSync(path, text, { mode: 0o600, flag: "wx" });
}

/**
 * Where each session's output is kept, in the ignored `.lab/` of this file's checkout: what a probe that
 * went another way than expected is read from. It holds a canary's text only where a read went through.
 */
const KEPT = join(git("rev-parse", "--show-toplevel"), ".lab", "sandbox-probe");

async function probe(): Promise<SessionRun[]> {
  mkdirSync(KEPT, { recursive: true });
  console.log(`sandbox-probe keeps each session's output in ${KEPT}`);

  for (const canary of canaries) {
    mkdirSync(dirname(canary.path), { recursive: true });
    writtenFiles.push(canary.path);
    writeFileSync(canary.path, canaryContentOf(canary), { mode: 0o600, flag: "wx" });
  }

  // The clone Dispatch makes for a Worker, then this checkout's own `HEAD` in it: the code under test.
  for (const session of SESSIONS) {
    const { tree } = layouts[session];
    clonesCreated.push(tree);
    git(...cloneArgvOf(git("remote", "get-url", "origin"), tree).slice(1));
    git("-C", tree, "fetch", "--quiet", dirname(dirname(KEPT)), "HEAD");
    git("-C", tree, "checkout", "--quiet", "--detach", "FETCH_HEAD");
  }

  const runs: SessionRun[] = [];

  for (const session of SESSIONS) {
    const layout = layouts[session];
    const probes = probesOf(facts, session);
    const { script, results } = layout;
    mkdirSync(layout.dir, { recursive: true });

    for (const link of layout.links) {
      symlinkSync(link.target, link.path);
    }

    writeFileSync(script, scriptOf(probes, layout));
    writeOwn(layout.settings, settings[session]);
    console.log(`sandbox-probe: the ${session} session makes its ${probes.length} probes…`);

    const ran = await runIsolated(sessionArgvOf(session, layout.settings, promptOf(probes, script)), {
      cwd: layout.tree,
      env: sessionEnvOf(process.env),
      timeoutMs: SESSION_TIMEOUT_MS,
    });

    if (ran.code !== 0) {
      console.error(`sandbox-probe: the ${session} session exited ${ran.code}: ${ran.stderr.trim().slice(-2000)}`);
    }

    writeFileSync(join(KEPT, `${session}.jsonl`), ran.stdout, { mode: 0o600 });
    runs.push({
      session,
      probes,
      results: resultsIn(results),
      stream: ran.stdout,
      landed: layout.touched.filter((path) => existsSync(path)),
    });
  }

  return runs;
}

try {
  const report = reportOf(await probe());
  console.log(report.text);
  process.exitCode = report.asExpected ? 0 : 1;
} finally {
  cleanUp();
}
