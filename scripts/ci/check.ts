#!/usr/bin/env bun

/**
 * `bun check`: runs each stage in turn and stops at the first that fails. A green run prints one
 * line naming what passed; a red one prints the failing stage's output and names it on its last
 * line, which the Stop hook keeps when it trims the report to its end.
 */

export interface Stage {
  readonly name: string;
  readonly command: readonly string[];
  /** What the green line says for this stage, from its output; its name when absent. */
  readonly label?: (output: string) => string;
}

export interface Ran {
  readonly exitCode: number;
  readonly output: string;
}

export type Verdict =
  | { readonly kind: "green"; readonly line: string }
  | { readonly kind: "red"; readonly exitCode: number; readonly report: string };

/** The count of `bun test`'s `Ran N tests across M files.` summary. */
export function testsLabel(output: string): string {
  const count = /^Ran (\d+ tests?) across/mu.exec(output)?.[1];

  if (count === undefined) {
    throw new Error("bun test printed no `Ran N tests` summary");
  }

  return count;
}

export const STAGES: readonly Stage[] = [
  { name: "typecheck", command: ["bun", "run", "typecheck"] },
  { name: "lint", command: ["bun", "run", "lint"] },
  { name: "format", command: ["bun", "run", "format:check"] },
  { name: "gates", command: ["bun", "run", "gates"] },
  { name: "knip", command: ["bun", "run", "knip"] },
  { name: "mods", command: ["bun", "run", "mods"] },
  {
    name: "tests",
    command: ["bun", "test", "--coverage", "--coverage-reporter=lcov"],
    label: testsLabel,
  },
  { name: "coverage floor", command: ["bun", "scripts/gates/check-coverage-floor.ts"] },
];

/** Runs `command` in the current directory, its stdout then its stderr captured as its output. */
export async function spawnStage(command: readonly string[]): Promise<Ran> {
  const child = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { exitCode, output: stdout + stderr };
}

export async function runStages(
  stages: readonly Stage[],
  run: (command: readonly string[]) => Promise<Ran>,
): Promise<Verdict> {
  const labels: string[] = [];

  for (const stage of stages) {
    const ran = await run(stage.command);

    if (ran.exitCode !== 0) {
      const output = ran.output.trimEnd();

      return {
        kind: "red",
        exitCode: ran.exitCode,
        report: `${output === "" ? "" : `${output}\n`}failed: ${stage.name}`,
      };
    }

    labels.push(stage.label === undefined ? stage.name : stage.label(ran.output));
  }

  return { kind: "green", line: `ok: ${labels.join(", ")}` };
}

if (import.meta.main) {
  const verdict = await runStages(STAGES, spawnStage);

  if (verdict.kind === "red") {
    console.error(verdict.report);
    process.exit(verdict.exitCode);
  }

  console.log(verdict.line);
}
