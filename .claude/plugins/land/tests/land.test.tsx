import type { TestBody } from "claude-code/testing";
import { expect, mock, test } from "claude-code/testing";

type Engine = Parameters<TestBody>[0];

type On = Parameters<TestBody>[1];

type Gate = { status: string; conclusion: string } | undefined;

type Pr = {
  state: string;
  labels: string[];
  url: string;
  gate: Gate;
};

type GitHub = {
  prs: Map<string, Pr>;
  failing: Map<string, string>;
  garbled: Set<string>;
};

type Seen = {
  spawned: string[];
  logs: string[];
  passed: string[];
};

const DENY =
  "land: land-ok is the Owner's Land approval. Only the Owner's own /land <n>, or the Owner on GitHub, puts it.";

const IN_PROGRESS: Gate = { status: "IN_PROGRESS", conclusion: "" };

const openPr = (n: number, overrides: Partial<Pr> = {}): Pr => ({
  state: "OPEN",
  labels: [],
  url: `https://github.com/bengous-labs/software-factory-lab/pull/${n}`,
  gate: IN_PROGRESS,
  ...overrides,
});

const gitHub = (prs: Record<number, Pr>): GitHub => ({
  prs: new Map(Object.entries(prs)),
  failing: new Map(),
  garbled: new Set(),
});

const rollupOf = (gate: Gate): unknown[] =>
  gate === undefined ? [] : [{ __typename: "CheckRun", name: "land-gate", ...gate }];

const answer = (pr: Pr, fields: string): string => {
  const all: Record<string, unknown> = {
    state: pr.state,
    url: pr.url,
    labels: pr.labels.map((name) => ({ id: name, name, description: "", color: "ededed" })),
    statusCheckRollup: rollupOf(pr.gate),
  };

  return JSON.stringify(Object.fromEntries(fields.split(",").map((field) => [field, all[field]])));
};

const reply = (github: GitHub, argv: readonly string[]): { stdout: string; stderr: string; code: number } => {
  const [, noun, verb, n = "", flag = "", value = ""] = argv;
  const failure = github.failing.get(argv.join(" "));
  const pr = github.prs.get(n);

  if (failure !== undefined) {
    return { stdout: "", stderr: `some context\n${failure}\n`, code: 1 };
  }

  if (github.garbled.has(argv.join(" "))) {
    return { stdout: "A new release of gh is available\n", stderr: "", code: 0 };
  }

  if (pr === undefined) {
    return { stdout: "", stderr: `GraphQL: Could not resolve to a PullRequest with the number of ${n}.\n`, code: 1 };
  }

  if (noun === "pr" && verb === "view" && flag === "--json") {
    return { stdout: answer(pr, value), stderr: "", code: 0 };
  }

  if (noun === "pr" && verb === "edit" && flag === "--add-label") {
    pr.labels = [...pr.labels.filter((label) => label !== value), value];

    return { stdout: `${pr.url}\n`, stderr: "", code: 0 };
  }

  if (noun === "pr" && verb === "edit" && flag === "--remove-label") {
    pr.labels = pr.labels.filter((label) => label !== value);

    return { stdout: `${pr.url}\n`, stderr: "", code: 0 };
  }

  return { stdout: "", stderr: `unknown command ${argv.join(" ")}\n`, code: 1 };
};

const stubEngine = (on: On, github: GitHub): Seen => {
  const seen: Seen = { spawned: [], logs: [], passed: [] };
  on("command.register", () => ({ value: { command: "land" } }));
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("process.spawn", async function* (_, e) {
    seen.spawned.push(e.argv.join(" "));
    const { stdout, stderr, code } = reply(github, e.argv);

    if (stdout !== "") {
      yield { stream: "stdout" as const, text: stdout };
    }

    if (stderr !== "") {
      yield { stream: "stderr" as const, text: stderr };
    }

    return { value: { code, signal: null } };
  });
  on("tool.call", (_, e) => {
    seen.passed.push(e.tool === "Bash" ? e.command : e.tool);

    return { result: "ran" };
  });
  on("ui.render", ($, e) => $.ui.resolve(e).Text({ children: ["engine"] }));
  on("ui.log", (_, e) => {
    seen.logs.push(e.text);

    return { value: undefined };
  });

  return seen;
};

type Kind = "composer" | "bridge" | "peer" | "sdk";

const ORIGINS = {
  composer: { kind: "composer" },
  bridge: { kind: "bridge" },
  peer: { kind: "peer" },
  sdk: { kind: "sdk" },
} as const;

const land = async ($: Engine, args: string, kind: Kind = "composer"): ReturnType<Engine["command"]["run"]> =>
  $.command.run({
    command: "land",
    args,
    origin: ORIGINS[kind],
    presentation: { isFullscreen: false, columns: 80 },
  });

const start = async ($: Engine): Promise<void> => {
  await $.session.start({ cwd: "/repo", surface: "terminal", isInteractive: true });
};

const SURFACES = ["terminal", "desktop"] as const;

const band = (surface: (typeof SURFACES)[number], hasSurvey = false) =>
  ({
    plugin: "land",
    component: "AbovePrompt",
    props: {
      hasSurvey,
      isWorking: false,
      maxRows: 10,
      bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
    surface,
  }) as const;

const rowsOf = async ($: Engine, surface: (typeof SURFACES)[number] = "terminal"): Promise<string[]> => {
  const ui = await $.ui.mount(band(surface));
  const texts = await ui.findAll({ type: "Text", text: /^#\d+/u });
  await ui.unmount();

  return texts.map((text) => text.text.trim());
};

const HALF_MINUTE = 30_000;

for (const kind of ["composer", "bridge"] as const) {
  test(`a ${kind} run puts land-ok and tells the person alone`, async ($, on) => {
    const github = gitHub({ 120: openPr(120) });
    const seen = stubEngine(on, github);
    mock.clock(on);
    await start($);

    const result = await land($, "120", kind);

    expect(result.text).toBeUndefined();
    expect(result.context).toBeUndefined();
    expect(github.prs.get("120")?.labels).toEqual(["land-ok"]);
    expect(seen.spawned.slice(0, 2)).toEqual([
      "gh pr view 120 --json state,labels,url",
      "gh pr edit 120 --add-label land-ok",
    ]);
    expect(seen.logs).toEqual(["land: land-ok is on #120, from your /land 120"]);
  });
}

for (const kind of ["peer", "sdk"] as const) {
  test(`a ${kind} run runs no gh`, async ($, on) => {
    const github = gitHub({ 120: openPr(120) });
    const seen = stubEngine(on, github);
    await start($);

    const result = await land($, "120", kind);

    expect(result.text).toBeUndefined();
    expect(result.context).toBeUndefined();
    expect(seen.spawned).toEqual([]);
    expect(seen.logs).toEqual([`land: /land runs only on the Owner's own typing, not on ${kind}`]);
    expect(await rowsOf($)).toEqual([]);
  });
}

test("a # before the number is taken", async ($, on) => {
  const github = gitHub({ 120: openPr(120) });
  stubEngine(on, github);
  mock.clock(on);
  await start($);

  await land($, " #120 ");

  expect(github.prs.get("120")?.labels).toEqual(["land-ok"]);
});

for (const args of ["", "120 121", "abc", "-1"]) {
  test(`"${args}" is not one pull request number`, async ($, on) => {
    const seen = stubEngine(on, gitHub({ 120: openPr(120) }));
    await start($);

    expect(await land($, args)).toEqual({});
    expect(seen.spawned).toEqual([]);
    expect(seen.logs).toEqual(["land: /land takes one pull request number, as /land 120"]);
  });
}

test("a pull request that does not read is reported by its last stderr line", async ($, on) => {
  const seen = stubEngine(on, gitHub({}));
  await start($);

  await land($, "999");

  expect(seen.logs).toEqual([
    "land: #999 does not read: GraphQL: Could not resolve to a PullRequest with the number of 999.",
  ]);
  expect(seen.spawned).toHaveLength(1);
});

for (const state of ["MERGED", "CLOSED"]) {
  test(`a ${state} pull request gets nothing`, async ($, on) => {
    const github = gitHub({ 120: openPr(120, { state }) });
    const seen = stubEngine(on, github);
    await start($);

    await land($, "120");

    expect(seen.logs).toEqual([`land: #120 is ${state}, nothing to approve`]);
    expect(github.prs.get("120")?.labels).toEqual([]);
    expect(seen.spawned).toHaveLength(1);
  });
}

test("land-ok already on is taken off first, so GitHub dates it anew", async ($, on) => {
  const github = gitHub({ 120: openPr(120, { labels: ["bug", "land-ok"] }) });
  const seen = stubEngine(on, github);
  mock.clock(on);
  await start($);

  await land($, "120");

  expect(seen.spawned.slice(0, 3)).toEqual([
    "gh pr view 120 --json state,labels,url",
    "gh pr edit 120 --remove-label land-ok",
    "gh pr edit 120 --add-label land-ok",
  ]);
  expect(github.prs.get("120")?.labels).toEqual(["bug", "land-ok"]);
  expect(seen.logs).toEqual(["land: land-ok is on #120, from your /land 120"]);
});

for (const flag of ["--remove-label", "--add-label"]) {
  test(`a failed ${flag} is reported and the band stays empty`, async ($, on) => {
    const github = gitHub({ 120: openPr(120, { labels: ["land-ok"] }) });
    github.failing.set(`gh pr edit 120 ${flag} land-ok`, "HTTP 403: Resource not accessible by integration");
    const seen = stubEngine(on, github);
    await start($);

    await land($, "120");

    expect(seen.logs).toEqual(["land: land-ok did not go on #120: HTTP 403: Resource not accessible by integration"]);
    expect(await rowsOf($)).toEqual([]);
  });
}

test("the band shows each pull request in the order it joined, with its link and the engine's band beneath", async ($, on) => {
  const github = gitHub({ 120: openPr(120), 121: openPr(121, { gate: undefined }) });
  stubEngine(on, github);
  mock.clock(on);
  await start($);

  await land($, "121");
  await land($, "120");

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface));
    const rows = await ui.findAll({ type: "Text", text: /^#\d+/u });
    const links = await ui.findAll({ type: "Link" });
    const buttons = await ui.findAll({ type: "Button" });
    const beneath = await ui.find({ type: "Text", text: "engine" });
    await ui.unmount();

    expect(rows.map((row) => row.text.trim())).toEqual([
      "#121  land-ok  land-gate: not posted",
      "#120  land-ok  land-gate: in progress",
    ]);
    expect(links.map((link) => [link.children, link.props["href"]])).toEqual([
      [["Open"], "https://github.com/bengous-labs/software-factory-lab/pull/121"],
      [["Open"], "https://github.com/bengous-labs/software-factory-lab/pull/120"],
    ]);
    expect(buttons.map((button) => button.props["label"])).toEqual(["Dismiss", "Dismiss"]);
    expect(beneath).toBeDefined();
  }
});

test("the band yields to a survey and is empty with no pull request", async ($, on) => {
  stubEngine(on, gitHub({ 120: openPr(120) }));
  mock.clock(on);
  await start($);

  expect(await rowsOf($)).toEqual([]);
  await land($, "120");

  const ui = await $.ui.mount(band("terminal", true));
  const rows = await ui.findAll({ type: "Text", text: /^#\d+/u });
  const beneath = await ui.find({ type: "Text", text: "engine" });
  await ui.unmount();

  expect(rows).toEqual([]);
  expect(beneath).toBeDefined();
});

test("a second /land of a pull request in the band labels again and keeps one row", async ($, on) => {
  const github = gitHub({ 120: openPr(120) });
  const seen = stubEngine(on, github);
  mock.clock(on);
  await start($);

  await land($, "120");
  await land($, "120");

  expect(seen.spawned.filter((argv) => argv.includes("--add-label"))).toHaveLength(2);
  expect(seen.spawned.filter((argv) => argv.includes("--remove-label"))).toHaveLength(1);
  expect(await rowsOf($)).toEqual(["#120  land-ok  land-gate: in progress"]);
});

test("every 30 seconds the band reads each pull request again", async ($, on) => {
  const github = gitHub({ 120: openPr(120) });
  const seen = stubEngine(on, github);
  const clock = mock.clock(on);
  await start($);
  await land($, "120");
  const before = seen.spawned.length;

  const pr = github.prs.get("120");
  if (pr !== undefined) {
    pr.gate = { status: "COMPLETED", conclusion: "SUCCESS" };
  }
  await clock.advance(HALF_MINUTE);

  expect(seen.spawned.slice(before)).toEqual(["gh pr view 120 --json state,statusCheckRollup"]);
  expect(await rowsOf($)).toEqual(["#120  land-ok  land-gate: success"]);
});

test("a merged pull request drops from the band and is reported landed", async ($, on) => {
  const github = gitHub({ 120: openPr(120), 121: openPr(121) });
  const seen = stubEngine(on, github);
  const clock = mock.clock(on);
  await start($);
  await land($, "120");
  await land($, "121");

  const pr = github.prs.get("120");
  if (pr !== undefined) {
    pr.state = "MERGED";
  }
  await clock.advance(HALF_MINUTE);

  expect(await rowsOf($)).toEqual(["#121  land-ok  land-gate: in progress"]);
  expect(seen.logs.at(-1)).toBe("land: #120 landed");
});

test("a closed pull request drops from the band, and the reads stop with the band empty", async ($, on) => {
  const github = gitHub({ 120: openPr(120) });
  const seen = stubEngine(on, github);
  const clock = mock.clock(on);
  await start($);
  await land($, "120");

  const pr = github.prs.get("120");
  if (pr !== undefined) {
    pr.state = "CLOSED";
  }
  await clock.advance(HALF_MINUTE);
  const after = seen.spawned.length;
  await clock.advance(4 * HALF_MINUTE);

  expect(await rowsOf($)).toEqual([]);
  expect(seen.logs.at(-1)).toBe("land: #120 was closed without landing");
  expect(seen.spawned).toHaveLength(after);
});

test("a row 60 minutes old drops with its last land-gate state", async ($, on) => {
  const github = gitHub({ 120: openPr(120) });
  const seen = stubEngine(on, github);
  const clock = mock.clock(on);
  await start($);
  await land($, "120");

  await clock.advance(119 * HALF_MINUTE);
  expect(await rowsOf($)).toEqual(["#120  land-ok  land-gate: in progress"]);
  await clock.advance(HALF_MINUTE);

  expect(await rowsOf($)).toEqual([]);
  expect(seen.logs.at(-1)).toBe("land: stopped following #120 after 60 minutes, land-gate in progress");
});

test("a failed read keeps the row and its last state", async ($, on) => {
  const github = gitHub({ 120: openPr(120) });
  const seen = stubEngine(on, github);
  const clock = mock.clock(on);
  await start($);
  await land($, "120");

  github.failing.set("gh pr view 120 --json state,statusCheckRollup", "HTTP 502: Bad Gateway");
  const pr = github.prs.get("120");
  if (pr !== undefined) {
    pr.gate = { status: "COMPLETED", conclusion: "FAILURE" };
  }
  await clock.advance(HALF_MINUTE);

  expect(await rowsOf($)).toEqual(["#120  land-ok  land-gate: in progress"]);
  expect(seen.logs).toEqual(["land: land-ok is on #120, from your /land 120"]);
});

test("Dismiss drops that row alone", async ($, on) => {
  stubEngine(on, gitHub({ 120: openPr(120), 121: openPr(121) }));
  mock.clock(on);
  await start($);
  await land($, "120");
  await land($, "121");

  const ui = await $.ui.mount(band("terminal"));
  await ui.press({ key: "dismiss-120" });
  await ui.unmount();

  expect(await rowsOf($)).toEqual(["#121  land-ok  land-gate: in progress"]);
});

const REFUSED = [
  "gh pr edit 120 --add-label land-ok",
  "gh issue edit 120 --add-label bug,land-ok",
  "gh api -X POST repos/o/r/issues/120/labels -f 'labels[]=land-ok'",
  "gh api --method=PUT repos/o/r/issues/120/labels --input labels.json # land-ok",
  "gh api repos/o/r/issues/120/labels -f labels[]=land-ok",
  "gh api repos/o/r/issues/120/labels -F labels[]=land-ok",
  "gh api repos/o/r/issues/120/labels --field labels[]=land-ok",
  "gh api repos/o/r/issues/120/labels --raw-field labels[]=land-ok",
  'echo \'{"labels":["land-ok"]}\' | gh api repos/o/r/issues/120/labels --input -',
  "gh label create land-ok",
  "cd /repo && gh pr edit 120 --add-label 'land-ok'",
  "gh label edit bug --name land-ok",
  "gh label list && gh label create land-ok",
];

for (const command of REFUSED) {
  test(`the guard refuses ${command}`, async ($, on) => {
    const seen = stubEngine(on, gitHub({}));

    const result = await $.tool.call({ tool: "Bash", command });

    expect(result).toEqual({ deny: DENY });
    expect(seen.passed).toEqual([]);
  });
}

const PASSED = [
  "gh pr view 120 --json labels",
  "gh api repos/o/r/issues/120/labels --jq '.[] | select(.name==\"land-ok\")'",
  "gh api -X GET repos/o/r/issues/120/labels --jq '.[].name' | grep land-ok",
  "gh pr edit 120 --remove-label land-ok",
  "gh pr edit 120 --add-label bug",
  "gh api -X POST repos/o/r/issues/120/labels -f 'labels[]=bug'",
  "grep -rn land-ok scripts/",
  "grep -n land-ok .claude/plugins/land/hooks/land.tsx && gh label list --repo o/r",
  "gh label list | grep land-ok",
];

for (const command of PASSED) {
  test(`the guard lets ${command} through`, async ($, on) => {
    const seen = stubEngine(on, gitHub({}));

    const result = await $.tool.call({ tool: "Bash", command });

    expect(result.isError).toBeUndefined();
    expect(seen.passed).toEqual([command]);
  });
}

const MCP_REFUSED = [
  { tool: "mcp__github__issue_write", issue_number: 120, labels: ["land-ok"] },
  { tool: "mcp__github__issue_write", issue_number: 120, label: "land-ok" },
  { tool: "mcp__github__update_pull_request", pull: { number: 120, labels: [{ name: "land-ok" }] } },
  { tool: "mcp__github__create_label", name: "land-ok" },
  { tool: "mcp__shell__run", command: "gh pr edit 120 --add-label land-ok" },
  { tool: "mcp__github__api", path: "repos/o/r/issues/120/labels", body: '{"labels":["land-ok"]}' },
  { tool: "mcp__shell__exec", command: "gh", args: ["gh", "pr", "edit", "120", "--add-label", "land-ok"] },
  { tool: "mcp__shell__exec", argv: ["gh", "pr", "edit", "120", "--add-label", "land-ok"] },
  { tool: "mcp__x__gh", args: ["api", "-X", "POST", "repos/o/r/issues/120/labels", "-f", "labels[]=land-ok"] },
  { tool: "mcp__github__api", method: "POST", path: "repos/o/r/issues/120/labels", body: '["land-ok"]' },
  { tool: "mcp__github__api", method: "POST", path: "repos/o/r/issues/120/labels", body: '"[\\"land-ok\\"]"' },
  { tool: "mcp__github__api", method: "PATCH", path: "repos/o/r/labels/bug", body: { new_name: "land-ok" } },
  { tool: "mcp__github__graphql", query: 'mutation{updateLabel(input:{id:"LA_x",name:"land-ok"}){label{id}}}' },
  {
    tool: "mcp__shell__run",
    command: "curl -X POST -d '[\"land-ok\"]' https://api.github.com/repos/o/r/issues/120/labels",
  },
  { tool: "mcp__github__add_issue_comment", issue_number: 120, body: "gh pr edit 120 --add-label land-ok" },
  { tool: "mcp__github__add_issue_comment", issue_number: 120, body: "land-ok" },
];

for (const call of MCP_REFUSED) {
  test(`the guard refuses the MCP call ${JSON.stringify(call)}`, async ($, on) => {
    const seen = stubEngine(on, gitHub({}));

    const result = await $.tool.call(call);

    expect(result).toEqual({ deny: DENY });
    expect(seen.passed).toEqual([]);
  });
}

test("the guard refuses a land-ok write nested as deep as the engine takes", async ($, on) => {
  const seen = stubEngine(on, gitHub({}));
  let deep: unknown = ["land-ok"];
  for (let level = 0; level < 27_000; level += 1) {
    deep = [deep];
  }

  const result = await $.tool.call({ tool: "mcp__shell__exec", argv: deep });

  expect(result).toEqual({ deny: DENY });
  expect(seen.passed).toEqual([]);
});

test("the guard lets an MCP call that names land-ok in its text through", async ($, on) => {
  const seen = stubEngine(on, gitHub({}));

  await $.tool.call({
    tool: "mcp__claude_desktop__recap",
    text: "#126 waits for the land-ok label, which only the Owner puts.",
  });
  await $.tool.call({
    tool: "mcp__github__add_issue_comment",
    issue_number: 120,
    body: "This change waits for land-ok.",
  });

  expect(seen.passed).toEqual(["mcp__claude_desktop__recap", "mcp__github__add_issue_comment"]);
});

test("the guard refuses a land-ok write through Monitor, and lets its other commands through", async ($, on) => {
  const seen = stubEngine(on, gitHub({}));

  const refused = await $.tool.call({
    tool: "Monitor",
    command: "gh pr edit 120 --add-label land-ok",
    description: "label",
    timeout_ms: 1000,
  });
  await $.tool.call({
    tool: "Monitor",
    command: "gh pr view 120 --json labels",
    description: "read",
    timeout_ms: 1000,
  });

  expect(refused).toEqual({ deny: DENY });
  expect(seen.passed).toEqual(["Monitor"]);
});

test("a pull request whose answer is not JSON does not read, and labels nothing", async ($, on) => {
  const github = gitHub({ 120: openPr(120) });
  github.garbled.add("gh pr view 120 --json state,labels,url");
  const seen = stubEngine(on, github);
  await start($);

  expect(await land($, "120")).toEqual({});
  expect(seen.logs).toEqual(["land: #120 does not read: gh pr view 120 answered no JSON"]);
  expect(github.prs.get("120")?.labels).toEqual([]);
});

test("a refresh whose answer is not JSON keeps the row and its last state", async ($, on) => {
  const github = gitHub({ 120: openPr(120) });
  const seen = stubEngine(on, github);
  const clock = mock.clock(on);
  await start($);
  await land($, "120");

  github.garbled.add("gh pr view 120 --json state,statusCheckRollup");
  await clock.advance(HALF_MINUTE);

  expect(await rowsOf($)).toEqual(["#120  land-ok  land-gate: in progress"]);
  expect(seen.logs).toEqual(["land: land-ok is on #120, from your /land 120"]);
});

test("the guard lets other MCP calls and other tools through", async ($, on) => {
  const seen = stubEngine(on, gitHub({}));

  await $.tool.call({ tool: "mcp__github__issue_write", issue_number: 120, labels: ["bug"] });
  await $.tool.call({ tool: "Grep", pattern: "land-ok" });

  expect(seen.passed).toEqual(["mcp__github__issue_write", "Grep"]);
});
