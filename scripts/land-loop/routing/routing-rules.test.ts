import { describe, expect, test } from "bun:test";

import * as fc from "fast-check";

import { LAB, SEGMENT, UNDER } from "../arbitraries.ts";
import { FACTORY_CONFIG_PATH } from "../factory-config.ts";
import type { RoutingPolicy } from "../factory-config.ts";
import type { RoutingAnswer } from "../merge-bot/decide.ts";
import {
  judgeAskOf,
  NIT_ANSWER_LINE_CAP,
  NON_EXECUTABLE,
  patchDeltaRulesOf,
  routingOf,
  routingRulesOf,
  withNitAnswers,
} from "./routing-rules.ts";
import type { NitAnswerInput, RoutingInput, RulesVerdict } from "./routing-rules.ts";

const lab = (input: RoutingInput): RulesVerdict => routingRulesOf(LAB, input);

const answerOf = (verdict: RulesVerdict): RoutingAnswer | null => (verdict.kind === "judged" ? null : verdict.answer);

const EMPTY: RoutingPolicy = { ownerPaths: [], factoryPaths: [], deepReviewPaths: [], lineCap: 400 };

const AUTO_DEEP = { land: "auto", review: "deep", secondRound: true, model: null } as const;

const OWNER_DEEP = { land: "owner", review: "deep", secondRound: true, model: null } as const;

const FACTORY_FILES = [
  "scripts/land-loop/routing/routing-rules.ts",
  "scripts/lint/layers.map.ts",
  "scripts/lab/verification.sh",
  ".claude/settings.json",
  ".mcp.json",
  "AGENTS.md",
  "CLAUDE.md",
  "package.json",
  "mise.toml",
  "tsconfig.json",
  "bunfig.toml",
  "oxlint.config.ts",
  "oxlint.style.config.ts",
  ".oxfmtrc.jsonc",
  "stryker.config.ts",
  "knip.json",
  "knip.jsonc",
];

describe("the lab's routing policy", () => {
  test("app code and docs under the cap are the Routing judge's", () => {
    expect(
      lab({ paths: ["app/src/commands/add.ts", "docs/usage.md"], lines: 40, deletedPaths: [], messages: ["feat: x"] }),
    ).toEqual({
      kind: "judged",
    });
  });

  test("a change to .github/ or to a path the Code review does not read goes to the Owner with review:deep", () => {
    for (const [input, reason] of [
      [
        { paths: [".github/workflows/ci.yml"], lines: 3, deletedPaths: [], messages: [] },
        "a path the Owner lands: .github/workflows/ci.yml",
      ],
      [{ paths: [FACTORY_CONFIG_PATH, "scripts/a.ts"], lines: 3, deletedPaths: [], messages: [] }, FACTORY_CONFIG_PATH],
      [
        { paths: ["bun.lock", "package.json"], lines: 3, deletedPaths: [], messages: [] },
        "a path the Owner lands: bun.lock",
      ],
      [
        { paths: ["scripts/vendor/anti-slop/a.md"], lines: 3, deletedPaths: [], messages: [] },
        "scripts/vendor/anti-slop/a.md",
      ],
      [
        { paths: [".github/a.yml"], lines: 3000, deletedPaths: [], messages: ["feat!: x"] },
        "a path the Owner lands: .github/a.yml",
      ],
    ] as const) {
      const verdict = lab(input);

      expect(verdict.kind).toBe("ruled");
      expect(answerOf(verdict)).toMatchObject(OWNER_DEEP);
      expect(answerOf(verdict)?.reason).toContain(reason);
    }
  });

  test("a change that touches only REVIEW.md, or only a prompt file a Judge reads, goes to the Owner", () => {
    for (const path of [
      "REVIEW.md",
      "scripts/land-loop/stop/done-prompt.ts",
      "scripts/land-loop/routing/routing-prompt.ts",
      "scripts/land-loop/review/review-prompt.ts",
      "scripts/land-loop/review/security-prompt.ts",
      "scripts/land-loop/a-new-prompt.ts",
    ]) {
      const verdict = lab({ paths: [path], lines: 3, deletedPaths: [], messages: [] });

      expect(verdict.kind).toBe("ruled");
      expect(answerOf(verdict)).toMatchObject(OWNER_DEEP);
      expect(answerOf(verdict)?.reason).toBe(`touches a path the Owner lands: ${path}`);
    }
  });

  test("a prompt's test, and a file named like a prompt outside the Land loop, stay off the Owner's route", () => {
    for (const path of ["scripts/land-loop/review/review-prompt.test.ts", "scripts/lib/a-prompt.ts"]) {
      expect(answerOf(lab({ paths: [path], lines: 3, deletedPaths: [], messages: [] }))).toMatchObject(AUTO_DEEP);
    }

    expect(lab({ paths: ["app/src/a-prompt.ts", "docs/REVIEW.md"], lines: 3, deletedPaths: [], messages: [] })).toEqual(
      {
        kind: "judged",
      },
    );
  });

  test("a change that touches no file has no route", () => {
    expect(() => lab({ paths: [], lines: 0, deletedPaths: [], messages: [] })).toThrow("at least one file");
  });

  test("a Patch delta that touches no file has nothing to read again: no judge, no second round, the whole PR's route", () => {
    const nothing = patchDeltaRulesOf(LAB, { paths: [], lines: 0, deletedPaths: [], messages: [] });

    expect(nothing).toEqual({
      kind: "ruled",
      answer: { ...AUTO_DEEP, secondRound: false, reason: "the Patch delta touches no file: nothing to read again" },
    });

    for (const paths of [["scripts/a.ts"], ["app/src/cli.ts"], [".github/a.yml"]]) {
      const whole = lab({ paths, lines: 3, deletedPaths: [], messages: [] });

      expect(judgeAskOf(whole, nothing)).toEqual({ kind: "none" });
      expect(routingOf(whole, nothing, null).secondRound).toBe(false);
      expect(routingOf(whole, nothing, null).land).toBe(answerOf(whole)?.land ?? "auto");
    }

    expect(patchDeltaRulesOf(LAB, { paths: ["app/src/cli.ts"], lines: 0, deletedPaths: [], messages: [] })).toEqual({
      kind: "judged",
    });

    const delta = { paths: [".github/a.yml", "app/src/cli.ts"], lines: 0, deletedPaths: [], messages: [] };

    expect(patchDeltaRulesOf(LAB, delta)).toEqual(lab(delta));
  });

  test("the factory's own code, its session settings, the agent docs and the build and gate configs land auto after a deep review", () => {
    for (const path of FACTORY_FILES) {
      const verdict = lab({ paths: [path], lines: 3, deletedPaths: [], messages: [] });

      expect(verdict.kind).toBe("ruled");
      expect(answerOf(verdict)).toMatchObject(AUTO_DEEP);
      expect(answerOf(verdict)?.reason).toContain(`a path a deep review reads: ${path}`);
    }
  });

  test("the task file's format lands auto after a deep review, under the breaking-commit hold", () => {
    const paths = ["app/src/store/store.ts"];

    expect(lab({ paths, lines: 400, deletedPaths: [], messages: ["fix(store): x"] })).toMatchObject({
      kind: "ruled",
      answer: AUTO_DEEP,
    });
    expect(answerOf(lab({ paths, lines: 3, deletedPaths: [], messages: ["feat(store)!: drop v1"] }))?.land).toBe(
      "owner",
    );
    expect(lab({ paths, lines: 401, deletedPaths: [], messages: [] })).toMatchObject({
      kind: "ruled",
      answer: AUTO_DEEP,
    });
    expect(
      answerOf(lab({ paths: [...paths, "scripts/a.ts"], lines: 3, deletedPaths: [], messages: ["feat!: x"] }))?.land,
    ).toBe("owner");
  });

  test("the reason names the first three paths a rule matched", () => {
    expect(
      answerOf(
        lab({
          paths: ["scripts/a.ts", "scripts/b.ts", "scripts/c.ts", "scripts/d.ts"],
          lines: 4,
          deletedPaths: [],
          messages: [],
        }),
      )?.reason,
    ).toBe(
      "touches a path a deep review reads: scripts/a.ts, scripts/b.ts, scripts/c.ts; lands once CI is green and no Important is open",
    );
  });

  test("a config of the same name outside the root is the Routing judge's", () => {
    expect(
      lab({ paths: ["app/bunfig.toml", "app/oxlint.config.ts"], lines: 1, deletedPaths: [], messages: [] }).kind,
    ).toBe("judged");
  });
});

const deleting = (paths: readonly string[], lines = 46): RoutingInput => ({
  paths,
  lines,
  deletedPaths: paths,
  messages: [],
});

const LIGHT = { land: "auto", review: "light", secondRound: true, model: null } as const;

describe("a change that only deletes files", () => {
  test("gets a light review when its factory and deep paths are all Markdown or text, as PR #75's skill deletion", () => {
    expect(answerOf(lab(deleting([".claude/skills/effect-ts/SKILL.md", "skills-lock.json"])))).toEqual({
      ...LIGHT,
      security: true,
      reason:
        "deletes only Markdown and text files under a deep-review path: .claude/skills/effect-ts/SKILL.md; lands once CI is green and no Important is open",
    });
    expect(answerOf(lab(deleting(["AGENTS.md"])))).toMatchObject(LIGHT);
    expect(
      answerOf(lab(deleting(["scripts/a.md", "scripts/b.mdx", "scripts/c.txt", "app/src/store/d.md"])))?.reason,
    ).toBe(
      "deletes only Markdown and text files under a deep-review path: scripts/a.md, scripts/b.mdx, scripts/c.txt; lands once CI is green and no Important is open",
    );
  });

  test("of no factory or deep path is the Routing judge's", () => {
    expect(lab(deleting(["docs/usage.md", "app/src/commands/count.ts"]))).toEqual({
      kind: "judged",
    });
  });

  test("keeps a deep review when one of its factory or deep paths is code or configuration", () => {
    for (const paths of [
      ["scripts/land-loop/review/principal-judge.ts"],
      [".claude/settings.json"],
      [".claude/skills/foo/SKILL.md", ".claude/skills/foo/run.ts"],
      ["app/src/store/store.ts"],
      ["scripts/a.md.ts"],
    ]) {
      expect(answerOf(lab(deleting(paths)))).toMatchObject(AUTO_DEEP);
    }
  });

  test("a change that modifies, adds or renames a path keeps a deep review, whatever that path is", () => {
    for (const [paths, deletedPaths] of [
      [["AGENTS.md"], []],
      [[".claude/skills/foo/SKILL.md", ".claude/skills/bar/SKILL.md"], [".claude/skills/foo/SKILL.md"]],
      [[".claude/skills/foo/SKILL.md", "app/src/cli.ts"], [".claude/skills/foo/SKILL.md"]],
    ] as const) {
      expect(answerOf(lab({ paths, lines: 3, deletedPaths, messages: [] }))).toMatchObject(AUTO_DEEP);
    }
  });

  test("an ownerPaths path keeps the Owner's route and a deep review, and past the cap the cap's answer stands", () => {
    expect(answerOf(lab(deleting([".github/workflows/old.yml"])))).toMatchObject(OWNER_DEEP);
    expect(answerOf(lab(deleting(["AGENTS.md"], LAB.lineCap + 1)))).toEqual({
      ...AUTO_DEEP,
      security: true,
      reason: `${LAB.lineCap + 1} lines changed, past the ${LAB.lineCap}-line cap`,
    });
  });

  test("NON_EXECUTABLE names Markdown and text files wherever they are", () => {
    expect(["a.md", "x/y/b.mdx", "c.txt"].every((path) => NON_EXECUTABLE.test(path))).toBe(true);
    expect(["a.ts", "b.json", "c.md.ts", "d.txt.sh", "md", "e.MD"].some((path) => NON_EXECUTABLE.test(path))).toBe(
      false,
    );
  });
});

describe("the breaking commits", () => {
  test("send a change outside the factory's paths to the Owner", () => {
    for (const [input, reason] of [
      [
        { paths: ["app/src/cli.ts"], lines: 3, deletedPaths: [], messages: ["feat!: drop list"] },
        "a breaking commit: feat!: drop list",
      ],
      [
        { paths: ["app/src/cli.ts"], lines: 3, deletedPaths: [], messages: ["feat: x\n\nBREAKING CHANGE: y"] },
        "a breaking commit: feat: x",
      ],
      [
        { paths: ["app/src/cli.ts"], lines: 3000, deletedPaths: [], messages: ["feat!: x"] },
        "a breaking commit: feat!: x",
      ],
    ] as const) {
      expect(lab(input)).toEqual({ kind: "ruled", answer: { ...OWNER_DEEP, reason, security: false } });
    }
  });

  test("a breaking marker that does not start a line breaks nothing", () => {
    expect(
      lab({ paths: ["app/src/cli.ts"], lines: 3, deletedPaths: [], messages: ["docs: explain the feat!: prefix"] })
        .kind,
    ).toBe("judged");
  });

  test("hold a change that mixes the factory's paths with other paths, which otherwise takes the rules' answer", () => {
    const paths = ["scripts/land-loop/pr-watch.ts", "app/src/cli.ts"];

    expect(answerOf(lab({ paths, lines: 3, deletedPaths: [], messages: ["fix(app)!: x"] }))?.land).toBe("owner");
    expect(lab({ paths, lines: 400, deletedPaths: [], messages: ["fix: x"] })).toMatchObject({
      kind: "ruled",
      answer: AUTO_DEEP,
    });
  });

  test("do not hold a change of the factory's paths only", () => {
    expect(
      lab({
        paths: ["scripts/land-loop/pr-watch.ts", "AGENTS.md"],
        lines: 3000,
        deletedPaths: [],
        messages: ["feat!: x"],
      }),
    ).toMatchObject({ kind: "ruled", answer: AUTO_DEEP });
  });
});

describe("the cap", () => {
  test("gives a change past it a deep review that lands auto, inside the factory's paths and outside, and asks no judge", () => {
    for (const [paths, security] of [
      [["app/src/cli.ts"], false],
      [["scripts/land-loop/pr-watch.ts"], true],
      [["scripts/land-loop/pr-watch.ts", "app/src/cli.ts"], true],
    ] as const) {
      const verdict = lab({ paths, lines: 401, deletedPaths: [], messages: ["feat: x"] });

      expect(verdict).toEqual({
        kind: "ruled",
        answer: { ...AUTO_DEEP, reason: "401 lines changed, past the 400-line cap", security },
      });
      expect(judgeAskOf(verdict, null)).toEqual({ kind: "none" });
    }
  });

  test("is the policy's", () => {
    const policy: RoutingPolicy = { ...EMPTY, lineCap: 10 };

    expect(routingRulesOf(policy, { paths: ["a.ts"], lines: 10, deletedPaths: [], messages: [] }).kind).toBe("judged");
    expect(routingRulesOf(policy, { paths: ["a.ts"], lines: 11, deletedPaths: [], messages: [] })).toEqual({
      kind: "ruled",
      answer: { ...AUTO_DEEP, reason: "11 lines changed, past the 10-line cap", security: false },
    });
  });

  test("a Patch delta past it is read again whatever the judge would say, on a change no rule names or a ruled one", () => {
    const delta = patchDeltaRulesOf(LAB, {
      paths: ["docs/usage.md"],
      lines: LAB.lineCap + 1,
      deletedPaths: [],
      messages: [],
    });

    const within = patchDeltaRulesOf(LAB, {
      paths: ["docs/usage.md"],
      lines: LAB.lineCap,
      deletedPaths: [],
      messages: [],
    });

    expect(delta).toMatchObject({ kind: "ruled", answer: { secondRound: true } });
    expect(within.kind).toBe("judged");
    expect(judgeAskOf(JUDGED, delta)).toEqual({ kind: "none" });
    expect(routingOf(JUDGED, delta, null).secondRound).toBe(true);
    expect(routingOf(RULED_ONLY, delta, null).secondRound).toBe(true);
  });
});

const judge = (land: RoutingAnswer["land"]): RoutingAnswer => ({
  land,
  review: "light",
  secondRound: false,
  reason: "costly to undo",
  model: "claude-haiku-5-5",
});

const RULED: RoutingAnswer = { ...AUTO_DEEP, reason: "touches scripts/a.ts" };

const RULED_ONLY: RulesVerdict = { kind: "ruled", answer: RULED };

const JUDGED: RulesVerdict = { kind: "judged" };

describe("judgeAskOf", () => {
  test("with no Patch delta, asks about a change no rule names, and nothing of a ruled one", () => {
    expect(judgeAskOf(JUDGED, null)).toEqual({ kind: "ask" });
    expect(judgeAskOf(RULED_ONLY, null)).toEqual({ kind: "none" });
  });

  test("on a Patch delta, asks exactly when the delta's own verdict is judged", () => {
    expect(judgeAskOf(RULED_ONLY, JUDGED)).toEqual({ kind: "ask" });
    expect(judgeAskOf(JUDGED, JUDGED)).toEqual({ kind: "ask" });
    expect(judgeAskOf(RULED_ONLY, RULED_ONLY)).toEqual({ kind: "none" });
    expect(judgeAskOf(JUDGED, RULED_ONLY)).toEqual({ kind: "none" });
  });
});

describe("routingOf", () => {
  test("a change no rule names takes the Routing judge's Review depth, and lands auto whatever the judge answers", () => {
    const judged = { ...judge("auto"), security: false };

    expect(routingOf(JUDGED, null, judge("auto"))).toEqual(judged);
    expect(routingOf(JUDGED, null, judge("owner"))).toEqual(judged);
    expect(routingOf(JUDGED, JUDGED, judge("owner"))).toEqual(judged);
  });

  test("a ruled change keeps the rules' answer, and asks no judge", () => {
    expect(routingOf(RULED_ONLY, null, null)).toEqual(RULED);
  });

  test("a ruled change keeps the rules' route whatever the judge says of its Patch delta, which it only asks whether to read again", () => {
    expect(routingOf(RULED_ONLY, JUDGED, judge("owner"))).toEqual({ ...RULED, secondRound: false });
    expect(routingOf(RULED_ONLY, JUDGED, { ...judge("auto"), secondRound: true })).toEqual(RULED);
  });

  test("on a ruled Patch delta, a ruled change is read again when the delta's rules say so", () => {
    expect(routingOf(RULED_ONLY, RULED_ONLY, null)).toEqual(RULED);
    expect(routingOf(RULED_ONLY, { kind: "ruled", answer: { ...RULED, secondRound: false } }, null)).toEqual({
      ...RULED,
      secondRound: false,
    });
  });

  test("a change no rule names whose Patch delta is ruled takes the delta's answer, asks no judge, and lands auto", () => {
    const delta: RoutingAnswer = { ...RULED, reason: "the delta", security: false };

    expect(routingOf(JUDGED, { kind: "ruled", answer: delta }, null)).toEqual(delta);
    expect(routingOf(JUDGED, { kind: "ruled", answer: { ...delta, land: "owner", security: true } }, null)).toEqual(
      delta,
    );
  });

  test("a change the judge was not asked about, though its verdict needs it, fails", () => {
    expect(() => routingOf(JUDGED, null, null)).toThrow("the Routing judge was not asked about a judged change");
    expect(() => routingOf(JUDGED, JUDGED, null)).toThrow("judged change");
    expect(() => routingOf(RULED_ONLY, JUDGED, null)).toThrow("judged change");
  });
});

describe("under the lab's policy, the Patch delta of a change that mixes the factory's paths with a path no rule names", () => {
  // PR #88's shape: the PR touched .gitignore among the factory's paths, and its round-1 fix touched a factory path only.
  const whole = lab({
    paths: [".gitignore", "scripts/land-loop/stop/hook.ts"],
    lines: 30,
    deletedPaths: [],
    messages: ["fix: x"],
  });

  test("is ruled as a whole, and lands auto after a deep review", () => {
    expect(whole).toMatchObject({ kind: "ruled", answer: AUTO_DEEP });
  });

  test("that touches the factory's paths only asks the Routing judge nothing and keeps the rules' route", () => {
    const patchDelta = lab({
      paths: ["scripts/land-loop/stop/hook.test.ts"],
      lines: 0,
      deletedPaths: [],
      messages: [],
    });

    expect(judgeAskOf(whole, patchDelta)).toEqual({ kind: "none" });
    expect(routingOf(whole, patchDelta, null)).toMatchObject(AUTO_DEEP);
  });

  test("that touches the path no rule names alone asks the Routing judge whether to read it again, and keeps the rules' route", () => {
    const patchDelta = lab({ paths: [".gitignore"], lines: 0, deletedPaths: [], messages: [] });

    expect(judgeAskOf(whole, patchDelta)).toEqual({ kind: "ask" });
    expect(routingOf(whole, patchDelta, judge("owner"))).toMatchObject({ ...AUTO_DEEP, secondRound: false });
  });

  test("that touches both is ruled, and asks the Routing judge nothing", () => {
    const patchDelta = lab({
      paths: [".gitignore", "scripts/land-loop/stop/hook.test.ts"],
      lines: 0,
      deletedPaths: [],
      messages: [],
    });

    expect(judgeAskOf(whole, patchDelta)).toEqual({ kind: "none" });
  });
});

const FACTORY_PATH = fc.oneof(
  fc.constantFrom("AGENTS.md", "package.json", "stryker.config.ts", ".mcp.json"),
  fc
    .constantFrom("scripts/land-loop", "scripts/lint", ".claude")
    .chain(UNDER)
    // A prompt file under scripts/land-loop is the Owner's, not the factory's alone.
    .filter((path) => !path.endsWith("-prompt.ts")),
);

const ANY_PATH = fc.array(SEGMENT, { minLength: 1, maxLength: 4 }).map((segments) => segments.join("/"));

const matches = (globs: readonly string[], path: string): boolean =>
  globs.some((glob) => new Bun.Glob(glob).match(path));

const NOT_OWNER_PATH = fc
  .oneof(ANY_PATH, FACTORY_PATH, UNDER("app/src"))
  .filter((path) => !matches([FACTORY_CONFIG_PATH, ...LAB.ownerPaths], path));

const BREAKING = /^\w+(\([^)]*\))?!:|BREAKING CHANGE/mu;

const JUDGE: fc.Arbitrary<RoutingAnswer> = fc.record({
  land: fc.constantFrom("auto", "owner"),
  review: fc.constantFrom("none", "light", "deep"),
  secondRound: fc.boolean(),
  reason: fc.string(),
  model: fc.option(fc.string(), { nil: null }),
});

const CHANGE = (path: fc.Arbitrary<string>) =>
  fc.record({
    paths: fc.array(path, { minLength: 1 }),
    lines: fc.integer({ min: 0, max: 2000 }),
    deletedPaths: fc.constant([]),
    messages: fc.array(fc.oneof(fc.string(), fc.constantFrom("feat!: x", "fix: y\n\nBREAKING CHANGE: z"))),
  });

describe("under the lab's policy", () => {
  test("a change of the factory's paths only lands auto after a deep review, whatever its size or its messages", () => {
    fc.assert(
      fc.property(CHANGE(FACTORY_PATH), (input) => {
        expect(lab(input)).toMatchObject({ kind: "ruled", answer: AUTO_DEEP });
      }),
    );
  });

  test("a change with no ownerPaths path, no factory config and no breaking commit outside the factory's paths never goes to the Owner, whatever the Routing judge answers", () => {
    fc.assert(
      fc.property(
        fc.record({
          change: CHANGE(NOT_OWNER_PATH),
          delta: fc.option(CHANGE(NOT_OWNER_PATH), { nil: null }),
          judge: JUDGE,
        }),
        ({ change, delta, judge: answer }) => {
          const verdict = lab(change);
          const patchDelta = delta === null ? null : lab(delta);
          const routed = routingOf(verdict, patchDelta, judgeAskOf(verdict, patchDelta).kind === "ask" ? answer : null);
          const factoryOnly = change.paths.every((path) => matches(LAB.factoryPaths, path));
          const heldBreaking = !factoryOnly && change.messages.some((message) => BREAKING.test(message));

          expect(routed.land).toBe(heldBreaking ? "owner" : "auto");
        },
      ),
    );
  });
});

const delta = (paths: readonly string[], lines: number): RoutingInput => ({
  paths,
  lines,
  deletedPaths: [],
  messages: [],
});

describe("withNitAnswers", () => {
  const READ: RoutingAnswer = { ...AUTO_DEEP, reason: "touches a path a deep review reads" };

  const AFTER_CLEAN_ROUND_3: NitAnswerInput = {
    record: { reviewRounds: 3, importantByRound: [1, 0, 0], reviewedHead: "h3" },
    deltaFrom: "h3",
    nitPaths: ["scripts/a.ts", "scripts/a.test.ts", "app/src/store/format.ts"],
  };

  const withRecord = (record: Partial<NitAnswerInput["record"]>): NitAnswerInput => ({
    ...AFTER_CLEAN_ROUND_3,
    record: { ...AFTER_CLEAN_ROUND_3.record, ...record },
  });

  const nitsOn = (nitPaths: readonly string[]): NitAnswerInput => ({ ...AFTER_CLEAN_ROUND_3, nitPaths });

  const nitsOnly = (input: NitAnswerInput, answer = READ): RoutingAnswer =>
    withNitAnswers(LAB, answer, delta(["scripts/a.ts"], 10), input);

  test("after a Review round 3 with no Important, a Patch delta from its head in round 3's Nit files within the cap needs no read, and keeps its route", () => {
    expect(withNitAnswers(LAB, READ, delta(["scripts/a.ts", "scripts/a.test.ts"], 42), AFTER_CLEAN_ROUND_3)).toEqual({
      ...READ,
      secondRound: false,
      reason: "a push after Review round 3 that only answers its Nits: 42 lines in scripts/a.ts, scripts/a.test.ts",
    });
    expect(
      withNitAnswers(
        LAB,
        { ...READ, land: "owner" },
        delta(["scripts/a.ts"], NIT_ANSWER_LINE_CAP),
        AFTER_CLEAN_ROUND_3,
      ),
    ).toEqual({
      ...READ,
      land: "owner",
      secondRound: false,
      reason: "touches a path a deep review reads",
    });
  });

  test("a delta with a file round 3 posted no Nit on, past the cap, or in a deepReviewPaths path keeps its answer", () => {
    expect(withNitAnswers(LAB, READ, delta(["scripts/a.ts", "scripts/b.ts"], 10), AFTER_CLEAN_ROUND_3)).toBe(READ);
    expect(withNitAnswers(LAB, READ, delta(["scripts/a.ts"], NIT_ANSWER_LINE_CAP + 1), AFTER_CLEAN_ROUND_3)).toBe(READ);
    expect(withNitAnswers(LAB, READ, delta(["app/src/store/format.ts"], 10), AFTER_CLEAN_ROUND_3)).toBe(READ);
  });

  test("a delta on a Nit file and the test file beside it needs no read; a test file whose source got no Nit keeps its answer", () => {
    const input = nitsOn(["scripts/c.ts", "app/src/v.tsx"]);

    for (const paths of [
      ["scripts/c.ts", "scripts/c.test.ts"],
      ["scripts/c.test.ts"],
      ["app/src/v.tsx", "app/src/v.test.tsx"],
    ]) {
      expect(withNitAnswers(LAB, READ, delta(paths, 10), input)).toEqual({
        ...READ,
        secondRound: false,
        reason: `a push after Review round 3 that only answers its Nits: 10 lines in ${paths.join(", ")}`,
      });
    }

    for (const paths of [
      ["scripts/c.ts", "scripts/b.test.ts"],
      ["scripts/c.ts", "scripts/sub/c.test.ts"],
      ["scripts/c.ts", "scripts/c.spec.ts"],
      ["app/src/v.tsx", "app/src/v.test.ts"],
      ["scripts/c.ts", "xscripts/c.test.ts"],
      ["scripts/c.ts", "scripts/c.test.tsx"],
    ]) {
      expect(withNitAnswers(LAB, READ, delta(paths, 10), input)).toBe(READ);
    }

    expect(
      withNitAnswers(LAB, READ, delta(["scripts/c.ts", "scripts/c.test.ts"], NIT_ANSWER_LINE_CAP + 1), input),
    ).toBe(READ);
    expect(withNitAnswers(LAB, READ, delta(["docs/c.test.ts.md"], 10), nitsOn(["docs/c.ts.md"]))).toBe(READ);
    expect(
      withNitAnswers(LAB, READ, delta(["app/src/store/format.test.ts"], 10), nitsOn(["app/src/store/format.ts"])),
    ).toBe(READ);
  });

  test("a delta that does not start at round 3's head, as after a rebase, keeps its answer", () => {
    expect(nitsOnly({ ...AFTER_CLEAN_ROUND_3, deltaFrom: "merge-base" })).toBe(READ);
    expect(nitsOnly({ ...withRecord({ reviewedHead: null }), deltaFrom: "merge-base" })).toBe(READ);
  });

  test("after a round 1, a round 2 and a round 3 with no Important, a delta from that round's head in its Nit files within the cap needs no read", () => {
    const clean: ReadonlyArray<[number, ReadonlyArray<number | null>]> = [
      [1, [0]],
      [2, [2, 0]],
      [3, [1, 1, 0]],
      [2, [null, 0, 5]],
    ];

    for (const [reviewRounds, importantByRound] of clean) {
      expect(nitsOnly(withRecord({ reviewRounds, importantByRound }))).toEqual({
        ...READ,
        secondRound: false,
        reason: `a push after Review round ${reviewRounds} that only answers its Nits: 10 lines in scripts/a.ts`,
      });
    }
  });

  test("after a round that posted an Important, or whose count is unknown, a delta keeps its answer, whichever the round", () => {
    const unclean: ReadonlyArray<[number, ReadonlyArray<number | null>]> = [
      [1, [1]],
      [1, [null]],
      [1, []],
      [2, [0, 1]],
      [2, [0, null]],
      [2, [0]],
      [3, [1, 0, 1]],
      [3, [1, 0, null]],
      [3, [1, 0]],
      [0, []],
      [0, [0]],
    ];

    for (const [reviewRounds, importantByRound] of unclean) {
      expect(nitsOnly(withRecord({ reviewRounds, importantByRound }))).toBe(READ);
    }

    expect(nitsOnly({ ...AFTER_CLEAN_ROUND_3, record: { reviewRounds: 3, reviewedHead: "h3" } })).toBe(READ);
    expect(nitsOnly({ ...AFTER_CLEAN_ROUND_3, record: { reviewRounds: 1, reviewedHead: "h3" } })).toBe(READ);
  });

  test("a delta that needs no read already keeps its answer and its reason", () => {
    const unread = { ...READ, secondRound: false, reason: "the Patch delta touches no file: nothing to read again" };

    expect(nitsOnly(AFTER_CLEAN_ROUND_3, unread)).toBe(unread);
  });
});

const securityOf = (paths: readonly string[], lines = 3): boolean | undefined =>
  answerOf(lab({ paths, lines, deletedPaths: [], messages: ["feat: x"] }))?.security;

const change = (paths: readonly string[], lines = 3): RoutingInput => ({
  paths,
  lines,
  deletedPaths: [],
  messages: [],
});

describe("the security pass", () => {
  test("a change with a factory, Owner or deep-review path, or the factory config, gets it", () => {
    expect(securityOf(["scripts/land-loop/merge-bot/main.ts"])).toBe(true);
    expect(securityOf([".github/workflows/ci.yml"])).toBe(true);
    expect(securityOf(["app/src/store/store.ts"])).toBe(true);
    expect(securityOf([FACTORY_CONFIG_PATH])).toBe(true);
    expect(securityOf(["scripts/land-loop/merge-bot/main.ts", "docs/usage.md"], LAB.lineCap + 1)).toBe(true);
  });

  test("a change with none of them gets none: the judge's answer, or the cap's", () => {
    expect(lab(change(["app/src/commands/add.ts", "docs/usage.md"]))).toEqual({ kind: "judged" });
    expect(securityOf(["app/src/commands/add.ts", "app/src/cli.ts"], LAB.lineCap + 1)).toBe(false);
    expect(routingOf(JUDGED, null, judge("auto")).security).toBe(false);
    expect(routingOf(JUDGED, JUDGED, { ...judge("auto"), security: true }).security).toBe(false);
  });

  test("a Patch delta keeps the whole PR's flag, whatever the delta touches", () => {
    const whole = lab(change(["scripts/a.ts", "app/src/cli.ts"]));
    const appOnly = lab(change(["app/src/cli.ts"], LAB.lineCap + 1));
    const nothing = patchDeltaRulesOf(LAB, change([], 0));

    expect(routingOf(whole, appOnly, null).security).toBe(true);
    expect(routingOf(whole, nothing, null).security).toBe(true);
    expect(routingOf(whole, JUDGED, judge("auto")).security).toBe(true);
    expect(routingOf(JUDGED, lab(change(["scripts/a.ts"])), null).security).toBe(false);
  });

  test("a change is flagged exactly when one of its paths matches the config, ownerPaths, factoryPaths or deepReviewPaths", () => {
    const risky = [FACTORY_CONFIG_PATH, ...LAB.ownerPaths, ...LAB.factoryPaths, ...LAB.deepReviewPaths];

    fc.assert(
      fc.property(CHANGE(fc.oneof(ANY_PATH, FACTORY_PATH, UNDER("app/src"), UNDER(".github"))), (input) => {
        const verdict = lab(input);
        const flagged = input.paths.some((path) => matches(risky, path));

        expect(verdict.kind === "ruled" && verdict.answer.security === true).toBe(flagged);
        expect(verdict.kind === "judged" || verdict.answer.security === flagged).toBe(true);
      }),
    );
  });
});
