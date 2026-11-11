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

/** Runs `command` in the current directory, its stderr sent into its stdout so the lines keep their order. */
export async function spawnStage(command: readonly string[]): Promise<Ran> {
  // `sh` merges the two streams: `Bun.spawn` gives each its own pipe.
  const child = Bun.spawn(["sh", "-c", '"$@" 2>&1', "sh", ...command], { stdout: "pipe", stderr: "inherit" });
  const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);

  return { exitCode, output };
}

const failed = (stage: Stage, exitCode: number, output: string): Verdict => {
  const shown = output.trimEnd();

  return { kind: "red", exitCode, report: `${shown === "" ? "" : `${shown}\n`}failed: ${stage.name}` };
};

export async function runStages(
  stages: readonly Stage[],
  run: (command: readonly string[]) => Promise<Ran>,
): Promise<Verdict> {
  const labels: string[] = [];

  for (const stage of stages) {
    const ran = await run(stage.command);

    if (ran.exitCode !== 0) {
      return failed(stage, ran.exitCode, ran.output);
    }

    try {
      labels.push(stage.label === undefined ? stage.name : stage.label(ran.output));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return failed(stage, 1, [ran.output.trimEnd(), message].filter((part) => part !== "").join("\n"));
    }
  }

  return { kind: "green", line: `ok: ${labels.join(", ")}` };
}

/** Prints `verdict` (green on stdout, red on stderr) and returns the exit code `bun check` ends with. */
export function finish(
  verdict: Verdict,
  write: { readonly out: (line: string) => void; readonly err: (line: string) => void },
): number {
  if (verdict.kind === "red") {
    write.err(verdict.report);

    return verdict.exitCode;
  }

  write.out(verdict.line);

  return 0;
}

if (import.meta.main) {
  process.exit(finish(await runStages(STAGES, spawnStage), { out: console.log, err: console.error }));
}
