import { describe, expect, test } from "bun:test";

import type { SessionAnswer } from "../ports/review.ts";
import { promptOf } from "./review-prompt.ts";
import type { ReviewRequest } from "./review-report.ts";
import { mergedResultOf } from "./review-report.ts";
import { reviewRunOf } from "./review-run.ts";
import { securityPromptOf } from "./security-prompt.ts";

const REQUEST: ReviewRequest = {
  pr: 80,
  head: "e1249fc0000000000000000000000000000000aa",
  base: "6cf2698000000000000000000000000000000bbb",
  patch: "p1",
  round: 2,
  model: "claude-opus-5-5",
  effort: "high",
  security: false,
};

const GUIDES = { review: "# Review guide\n", project: "# Project\n" };

const THREADS = [{ where: "a.ts:3", finding: "**Nit**: a name", reply: "no answer (thread open)" }];

const RUN_URL = "https://github.com/o/r/actions/runs/1";

const FINDING = {
  file: "a.ts",
  line: 3,
  severity: "important",
  summary: "s",
  failure_scenario: "f",
  breaks: null,
};

/** A fake session that answers each prompt in turn, and keeps the prompts it was given. */
function fakeSession(answers: readonly SessionAnswer[]) {
  const prompts: string[] = [];

  const session = (prompt: string): Promise<SessionAnswer> => {
    const answer = answers[prompts.length];
    prompts.push(prompt);

    return answer === undefined ? Promise.reject(new Error("no answer left")) : Promise.resolve(answer);
  };

  return { prompts, session };
}

const INPUTS = { guides: GUIDES, threads: THREADS };

const answered = (findings: readonly object[]): SessionAnswer => ({
  kind: "answered",
  structured: { findings },
  model: "claude-opus-5-5",
  claudeCodeVersion: "2.1.318",
  tokens: null,
});

describe("reviewRunOf", () => {
  test("with no security pass asked, one session runs the Code review's prompt, and its result stands alone", async () => {
    const code = answered([FINDING]);
    const fake = fakeSession([code]);

    expect(await reviewRunOf(REQUEST, INPUTS, fake.session, RUN_URL)).toEqual(
      mergedResultOf(REQUEST, code, null, RUN_URL),
    );
    expect(fake.prompts).toEqual([promptOf(REQUEST, GUIDES, THREADS)]);
  });

  test("with a security pass asked, the Code review runs, then the security pass on its own prompt, and both answers merge", async () => {
    const request = { ...REQUEST, security: true };
    const code = answered([FINDING]);
    const security = answered([{ ...FINDING, severity: "nit" }]);
    const fake = fakeSession([code, security]);

    expect(await reviewRunOf(request, INPUTS, fake.session, RUN_URL)).toEqual(
      mergedResultOf(request, code, security, RUN_URL),
    );
    expect(fake.prompts).toEqual([promptOf(request, GUIDES, THREADS), securityPromptOf(request, GUIDES, THREADS)]);
  });

  test("a failed Code review session fails the round at once: the security pass does not run", async () => {
    const request = { ...REQUEST, security: true };
    const code: SessionAnswer = { ...answered([]), kind: "failed", error: "timed out after 1200000 ms" };
    const fake = fakeSession([code]);

    expect(await reviewRunOf(request, INPUTS, fake.session, RUN_URL)).toEqual(
      mergedResultOf(request, code, null, RUN_URL),
    );
    expect(fake.prompts).toEqual([promptOf(request, GUIDES, THREADS)]);
  });
});
