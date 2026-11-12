import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Run } from "../lib/run.port.ts";
import { argsOf, measure } from "./main.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

const REPO = "repos/bengous-labs/software-factory-lab";

const slurped = (file: string): string => `[${readFileSync(file, "utf8")}]`;

/** Serves the fixtures as `gh api --paginate --slurp` would, from the endpoint the measure asks for. */
const fixtureRun: Run = (argv) => {
  const endpoint = argv.at(-1) ?? "";
  const pull = /\/(?:pulls|issues)\/(\d+)\/(\w+)$/u.exec(endpoint);
  const checks = /\/commits\/(\w+)\/check-runs\?check_name=land-gate&filter=all$/u.exec(endpoint);

  const body = (): string => {
    if (endpoint === `${REPO}/pulls?state=closed&base=dev`) {
      return `[[${[86, 88, 91].map((n) => readFileSync(join(FIXTURES, String(n), "pull.json"), "utf8")).join(",")}]]`;
    }

    if (endpoint.startsWith(`${REPO}/commits?sha=dev&since=`)) {
      return slurped(join(FIXTURES, "dev-commits.json"));
    }

    if (pull !== null) {
      return slurped(join(FIXTURES, pull[1] ?? "", `${pull[2]}.json`));
    }

    const dir = readdirSync(FIXTURES).find((name) =>
      existsSync(join(FIXTURES, name, `check-runs-${checks?.[1]}.json`)),
    );

    return slurped(join(FIXTURES, dir ?? "", `check-runs-${checks?.[1]}.json`));
  };

  expect(argv.slice(0, 5)).toEqual(["gh", "api", "-X", "GET", "--paginate"]);

  return Promise.resolve({ code: 0, stdout: body(), stderr: "" });
};

describe("argsOf", () => {
  test("reads --since YYYY-MM-DD; anything else is refused", () => {
    expect(argsOf(["--since", "2026-11-02"])).toEqual({ since: "2026-11-02" });
    expect(argsOf([])).toBeNull();
    expect(argsOf(["--since"])).toBeNull();
    expect(argsOf(["--since", "2026-11"])).toBeNull();
    expect(argsOf(["--since", "2026-11-02", "extra"])).toBeNull();
    expect(argsOf(["2026-11-02"])).toBeNull();
  });
});

describe("measure", () => {
  test("reads the PRs merged since the date and their data through gh api, and reports them", async () => {
    const report = await measure(fixtureRun, "/repo", "2026-11-02");

    expect(report).toContain("| #86 | owner | 0h19 | 2 | 2 | 2 | 0 | 1 | – |");
    expect(report).toContain("| #91 | auto | – | 1 | 0 | 0 | 0 | 0 | – |");
  });

  test("a PR merged before the date or not merged is left out", async () => {
    expect(await measure(fixtureRun, "/repo", "2026-11-08")).not.toContain("| #");

    const report = await measure(
      (argv, options) =>
        fixtureRun(argv, options).then((ran) =>
          argv.at(-1)?.includes("pulls?state") === true
            ? { ...ran, stdout: ran.stdout.replace('"merged_at": "2026-11-07T22:51:26Z"', '"merged_at": null') }
            : ran,
        ),
      "/repo",
      "2026-11-02",
    );

    expect(report).not.toContain("#88");
  });
});
