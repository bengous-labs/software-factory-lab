#!/usr/bin/env bun

/**
 * The Worker bench: launches Workers on a fake issue, each in a throwaway clone of the current commit,
 * and prints what they say. `bun scripts/lab/bench.ts --help` says how.
 */

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import {
  argsOf,
  benchEnvOf,
  claudeArgv,
  closingOf,
  HELP,
  readingOf,
  reportOf,
  workerPrompt,
  workerSettings,
} from "./bench-report.ts";
import type { BenchArgs, Closing, SessionReport } from "./bench-report.ts";

/** What the bench touches outside its decisions. */
export interface BenchIo {
  /** The directory that holds the settings file and the clones. */
  readonly root: string;
  /** The path of the Worker settings file. */
  readonly settings: string;
  /** Makes the clone of run `run`, returns its directory. */
  readonly prepare: (run: number) => Promise<string>;
  /** Runs `argv` in `cwd` and returns its standard output; a failure throws. */
  readonly claude: (argv: readonly string[], cwd: string) => Promise<string>;
  /** The transcript of session `session`. */
  readonly transcript: (session: string) => Promise<string>;
}

export interface BenchRun {
  readonly issue: string;
  readonly issueText: string;
  readonly runs: number;
  readonly model: string | undefined;
  readonly wakeText: string | undefined;
}

async function runSession(io: BenchIo, bench: BenchRun, run: number): Promise<SessionReport> {
  const dir = await io.prepare(run);

  const launch = async (prompt: string, resume?: string): Promise<Closing> =>
    closingOf(await io.claude(claudeArgv({ settings: io.settings, prompt, model: bench.model, resume }), dir));

  const first = await launch(workerPrompt(bench.issueText));
  const closings = bench.wakeText === undefined ? [first] : [first, await launch(bench.wakeText, first.session)];
  const sessions = [...new Set(closings.map((closing) => closing.session))];
  const transcripts = await Promise.all(sessions.map((session) => io.transcript(session)));

  return { kind: "done", run, dir, closings, reading: readingOf(transcripts.join("\n")) };
}

/** The report of run `run`, or its failure: one run that fails leaves the others' reports. */
async function settledSession(io: BenchIo, bench: BenchRun, run: number): Promise<SessionReport> {
  try {
    return await runSession(io, bench, run);
  } catch (error) {
    return { kind: "failed", run, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Runs the bench's sessions side by side and returns the report. */
export async function runBench(io: BenchIo, bench: BenchRun): Promise<string> {
  const runs = Array.from({ length: bench.runs }, (_, index) => index + 1);
  const sessions = await Promise.all(runs.map((run) => settledSession(io, bench, run)));

  return reportOf({ ...bench, root: io.root }, sessions);
}

async function realIo(): Promise<BenchIo> {
  const root = await mkdtemp(join(tmpdir(), "worker-bench-"));
  const settings = join(root, "worker-settings.json");
  const ghConfig = join(root, "gh");
  const checkout = (await $`git rev-parse --show-toplevel`.text()).trim();
  const head = (await $`git rev-parse HEAD`.text()).trim();
  const config = process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");
  const projects = join(config, "projects");
  const sessionEnv = benchEnvOf(process.env, ghConfig);
  await mkdir(ghConfig);
  await writeFile(settings, `${JSON.stringify(workerSettings(join(config, "CLAUDE.md")))}\n`);

  return {
    root,
    settings,
    prepare: async (run) => {
      const dir = join(root, `run-${run}`);
      await $`git clone --quiet ${checkout} ${dir}`;
      await $`git -C ${dir} switch --quiet -c bench/run-${run} ${head}`;
      // The clone's origin is the checkout it came from: a plain `git push` must reach nothing.
      await $`git -C ${dir} remote set-url --push origin no-push`;

      return dir;
    },
    claude: async (argv, cwd) => {
      const child = Bun.spawn([...argv], { cwd, env: sessionEnv, stdout: "pipe", stderr: "inherit" });
      const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);

      if (code !== 0) {
        throw new Error(`claude in ${cwd} exited ${code}: ${stdout.trim()}`);
      }

      return stdout;
    },
    transcript: async (session) => {
      const [file] = await Array.fromAsync(new Bun.Glob(`*/${session}.jsonl`).scan({ cwd: projects }));

      if (file === undefined) {
        throw new Error(`no transcript of session ${session} under ${projects}`);
      }

      return readFile(join(projects, file), "utf8");
    },
  };
}

async function main(args: BenchArgs): Promise<void> {
  const issueText = await readFile(args.issue, "utf8");
  const wakeText = args.wake === undefined ? undefined : await readFile(args.wake, "utf8");

  const report = await runBench(await realIo(), { ...args, issueText, wakeText });

  process.stdout.write(report);
}

if (import.meta.main) {
  const parsed = argsOf(Bun.argv.slice(2));

  if (parsed.kind === "help") {
    process.stdout.write(`${HELP}\n`);
  } else if (parsed.kind === "error") {
    process.stderr.write(`${parsed.message}\n\n${HELP}\n`);
    process.exit(2);
  } else {
    await main(parsed.args);
  }
}
