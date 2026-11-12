/**
 * Each text a Judge reads lives in a `*.prompt.ts` file under `factory/`, which the routing policy sends
 * to the Owner: these tests hold the texts there, and the files on the Owner's route.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LAB } from "./arbitraries.fixtures.ts";
import * as reviewPrompt from "./review/code-review.prompt.ts";
import * as securityPrompt from "./review/security-pass.prompt.ts";
import * as routingPrompt from "./routing/routing-judge.prompt.ts";
import * as routingJudge from "./routing/routing-judge.ts";
import * as donePrompt from "./stop/done-judge.prompt.ts";
import * as hook from "./stop/hook.live.ts";

const FACTORY = join(import.meta.dir, "..");

const files = (pattern: string): string[] => [...new Bun.Glob(pattern).scanSync({ cwd: FACTORY })].toSorted();

/** The words that open each text a Judge reads. */
const OPENINGS = [
  "Stop hook question, not the Owner's",
  "Stop hook request, not the Owner's",
  "You route one change",
  "This is the security pass of this review",
  "Report every finding in the final structured answer",
];

describe("the texts a Judge reads", () => {
  test("the Done judge's question, the PR body request and the Routing judge's prompt are exported from *.prompt.ts files", () => {
    expect(Object.keys(donePrompt).toSorted()).toEqual(["BODY_REQUEST", "doneQuestionOf"]);
    expect(Object.keys(routingPrompt)).toEqual(["routingPromptOf"]);
    expect(donePrompt.doneQuestionOf([])).toContain("Stop hook question, not the Owner's");
    expect(donePrompt.BODY_REQUEST).toContain("Stop hook request, not the Owner's");
    expect(routingPrompt.routingPromptOf("stat", "diff", false)).toStartWith("You route one change");
    expect(Object.keys(reviewPrompt)).toContain("promptOf");
    expect(Object.keys(securityPrompt)).toEqual(["securityPromptOf"]);
  });

  test("and from nowhere else: neither the Stop hook nor the Routing judge exports a prompt", () => {
    for (const name of ["DONE_QUESTION", "BODY_REQUEST", "doneQuestionOf", "promptOf", "routingPromptOf"]) {
      expect(Object.keys(hook)).not.toContain(name);
      expect(Object.keys(routingJudge)).not.toContain(name);
    }
  });

  test("no other source file of the factory holds the words of one", () => {
    const sources = files("**/*.ts").filter((file) => !file.endsWith(".prompt.ts") && !file.endsWith(".test.ts"));

    expect(sources).toContain("land/stop/hook.live.ts");
    expect(sources).toContain("land/routing/routing-judge.ts");

    for (const file of sources) {
      const text = readFileSync(join(FACTORY, file), "utf8");

      expect({ file, holds: OPENINGS.filter((opening) => text.includes(opening)) }).toEqual({ file, holds: [] });
    }
  });

  test("every prompt file is a path the Owner lands under the lab's config", () => {
    const prompts = files("**/*.prompt.ts");

    expect(prompts).toEqual([
      "land/review/code-review.prompt.ts",
      "land/review/security-pass.prompt.ts",
      "land/routing/routing-judge.prompt.ts",
      "land/stop/done-judge.prompt.ts",
    ]);

    for (const file of prompts) {
      const path = `factory/${file}`;

      expect({ path, owner: LAB.ownerPaths.some((glob) => new Bun.Glob(glob).match(path)) }).toEqual({
        path,
        owner: true,
      });
    }
  });
});
