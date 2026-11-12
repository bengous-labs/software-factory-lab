import { describe, expect, test } from "bun:test";

import {
  apiKeyProblemOf,
  apiWorkerSettingsTextOf,
  branchOf,
  CHECKOUT_VARIABLE,
  dispatchArgsOf,
  firstTurnProblemOf,
  INSTALL_ARGV,
  issueBranchesIn,
  launchArgvOf,
  projectSettingsOf,
  promptOf,
  repoOfIssueUrl,
  sessionIdOf,
  sessionNameOf,
  slugOf,
  workerSettingsOf,
  workerSettingsProblemOf,
  worktreeListed,
  worktreeOf,
} from "./dispatch-plan.ts";

describe("dispatchArgsOf", () => {
  test("takes the issue and launches on opus by default, on the subscription", () => {
    expect(dispatchArgsOf(["168"])).toStrictEqual({ issue: 168, model: "opus", effort: undefined, api: false });
  });

  test("takes the model --model names, before or after the issue", () => {
    expect(dispatchArgsOf(["168", "--model", "sonnet"])).toEqual({
      issue: 168,
      model: "sonnet",
      effort: undefined,
      api: false,
    });
    expect(dispatchArgsOf(["--model", "fable", "7"])).toEqual({
      issue: 7,
      model: "fable",
      effort: undefined,
      api: false,
    });
  });

  test.each(["low", "medium", "high", "xhigh", "max"] as const)("takes the effort --effort %s names", (effort) => {
    expect(dispatchArgsOf(["168", "--effort", effort])).toEqual({ issue: 168, model: "opus", effort, api: false });
  });

  test("combines --model and --effort in either order", () => {
    const expected = { issue: 7, model: "sonnet", effort: "low", api: false } as const;
    expect(dispatchArgsOf(["7", "--model", "sonnet", "--effort", "low"])).toEqual(expected);
    expect(dispatchArgsOf(["--effort", "low", "--model", "sonnet", "7"])).toEqual(expected);
    expect(dispatchArgsOf(["--effort", "low", "7", "--model", "sonnet"])).toEqual(expected);
  });

  test("--api, wherever it stands, makes the Worker an API Worker", () => {
    const api = { issue: 168, model: "opus", effort: undefined, api: true };

    expect(dispatchArgsOf(["168", "--api"])).toEqual(api);
    expect(dispatchArgsOf(["--api", "168"])).toEqual(api);
    expect(dispatchArgsOf(["168", "--model", "sonnet", "--api"])).toEqual({ ...api, model: "sonnet" });
    expect(dispatchArgsOf(["--api", "--model", "sonnet", "168"])).toEqual({ ...api, model: "sonnet" });
    expect(dispatchArgsOf(["168", "--effort", "low", "--api"])).toEqual({ ...api, effort: "low" });
    expect(dispatchArgsOf(["--model", "--api", "sonnet", "168"])).toEqual({ ...api, model: "sonnet" });
  });

  test.each([
    [[]],
    [["0"]],
    [["12a"]],
    [["#12"]],
    [["1", "2"]],
    [["1", "--model"]],
    [["1", "--other", "x"]],
    [["1", "--effort"]],
    [["1", "--effort", "huge"]],
    [["1", "--effort", "High"]],
    [["1", "--effort", "--model", "opus"]],
    [["1", "--model", "--effort", "low"]],
    [["1", "--model", "--effort"]],
    [["--api"]],
    [["1", "--model", "--api"]],
    [["1", "--effort", "--api"]],
  ])("refuses %j with the usage", (argv) => {
    expect(() => dispatchArgsOf(argv)).toThrow(
      "usage: bun factory/bin/dispatch.ts <issue> [--model <model>] [--effort <low|medium|high|xhigh|max>] [--api]",
    );
  });
});

describe("slugOf", () => {
  test("keeps the title's words, lower case, joined by dashes", () => {
    expect(slugOf("Dispatch is no file of the repository: each session writes")).toBe(
      "dispatch-is-no-file-of-the-repository",
    );
  });

  test("cuts at a word under 40 characters", () => {
    expect(slugOf(`${"a".repeat(30)} ${"b".repeat(30)}`)).toBe("a".repeat(30));
  });

  test("stops at the first word that overflows, never keeping a later short one", () => {
    expect(slugOf(`${"a".repeat(30)} ${"b".repeat(30)} fix`)).toBe("a".repeat(30));
  });

  test("cuts a single long word at 40 characters, even when short words follow", () => {
    expect(slugOf(`${"x".repeat(50)} fix`)).toBe("x".repeat(40));
  });

  test("cuts a single long word at 40 characters", () => {
    expect(slugOf("x".repeat(50))).toBe("x".repeat(40));
  });

  test("drops what is not a letter or a digit", () => {
    expect(slugOf("`claude --bg` émet l'ID (v2)")).toBe("claude-bg-met-l-id-v2");
  });

  test("names a title with no word", () => {
    expect(slugOf("—")).toBe("issue");
  });
});

describe("branchOf", () => {
  test("is issue/<n>-<slug>, which the Stop hook reads as made for issue n", () => {
    expect(branchOf(168, "Dispatch is no file")).toBe("issue/168-dispatch-is-no-file");
  });
});

describe("worktreeOf", () => {
  test("lies under .claude/worktrees/ of the main checkout", () => {
    expect(worktreeOf("/repo", 168)).toBe("/repo/.claude/worktrees/issue-168");
  });
});

describe("workerSettingsOf", () => {
  test("is the Worker settings file under the home directory", () => {
    expect(workerSettingsOf("/home/me")).toBe("/home/me/.config/software-factory-lab/worker-settings.json");
  });
});

describe("repoOfIssueUrl", () => {
  test("reads owner/name from the issue's URL", () => {
    expect(repoOfIssueUrl("https://github.com/bengous-labs/software-factory-lab/issues/168")).toBe(
      "bengous-labs/software-factory-lab",
    );
  });

  test("refuses a URL that is no issue's", () => {
    expect(() => repoOfIssueUrl("https://github.com/o/r/pull/3")).toThrow("not an issue URL");
  });
});

describe("issueBranchesIn", () => {
  test("lists the local and remote branches made for the issue", () => {
    const refs = ["dev", "origin/dev", "fix/168-old", "origin/feat/168-x", "feat/1680-other", "issue/16-y", ""].join(
      "\n",
    );

    expect(issueBranchesIn(refs, 168)).toEqual(["fix/168-old", "origin/feat/168-x"]);
  });
});

describe("worktreeListed", () => {
  test("finds the worktree among those `git worktree list --porcelain` prints", () => {
    const listing = "worktree /repo\nHEAD abc\nbranch refs/heads/dev\n\nworktree /repo/.claude/worktrees/issue-1\n";

    expect(worktreeListed(listing, "/repo/.claude/worktrees/issue-1")).toBe(true);
    expect(worktreeListed(listing, "/repo/.claude/worktrees/issue-10")).toBe(false);
  });
});

describe("promptOf", () => {
  const assignment = {
    issue: 168,
    repo: "o/r",
    worktree: "/repo/.claude/worktrees/issue-168",
    branch: "issue/168-x",
  };

  test("names the issue, how to read it, the worktree and its branch, and nothing a Worker's instructions give", () => {
    expect(promptOf(assignment, false)).toBe(
      "Implement GitHub issue #168 of o/r (read it with: gh issue view 168 --repo o/r). Your worktree exists: first call EnterWorktree with the path /repo/.claude/worktrees/issue-168 and work there; its branch issue/168-x starts at origin/dev.",
    );
  });

  test("a Worker launched in its worktree is told it is there, and enters nothing", () => {
    expect(promptOf(assignment, true)).toBe(
      "Implement GitHub issue #168 of o/r (read it with: gh issue view 168 --repo o/r). You are in your worktree /repo/.claude/worktrees/issue-168: work there; its branch issue/168-x starts at origin/dev.",
    );
  });
});

/** The main checkout's settings: two of its hooks, and keys an API Worker does not take. */
const PROJECT = JSON.stringify({
  worktree: { baseRef: "fresh" },
  hooks: {
    Stop: [
      { hooks: [{ type: "command", command: 'bun "$CLAUDE_PROJECT_DIR"/factory/bin/stop-hook.ts', timeout: 900 }] },
    ],
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [
          {
            type: "command",
            command: 'bun "$CLAUDE_PROJECT_DIR"/factory/hooks/refuse-author-publish.ts',
            timeout: 30,
            onFailure: "block",
          },
        ],
      },
    ],
  },
  enabledPlugins: { "land@software-factory-lab": true },
});

const PLACE = { home: "/home/me", checkout: "/repo" };

/** The deny rules an API Worker's settings add: the two hidden directories, to read and to write. */
const DENY = [
  "Read(//home/me/.api-agent/**)",
  "Edit(//home/me/.api-agent/**)",
  "Read(//home/me/.config/software-factory-lab/**)",
  "Edit(//home/me/.config/software-factory-lab/**)",
];

/** The API Worker settings text made from the Worker settings `json`, for the home `/home/me` and the checkout `/repo`. */
const textOf = (json: string): string => apiWorkerSettingsTextOf(json, PROJECT, PLACE);

describe("apiWorkerSettingsTextOf", () => {
  const worker = {
    env: { LAB_AUTHOR: "1", GH_TOKEN: "ghp_worker" },
    outputStyle: "Proactive",
    claudeMdExcludes: ["/home/me/.claude/CLAUDE.md"],
  };

  test("keeps the Worker settings whole, and adds the key helper, the marker, the main checkout's hooks, the sandbox and the rules", () => {
    const text = textOf(JSON.stringify(worker));

    expect(text).toEndWith("}\n");
    expect(JSON.parse(text)).toEqual({
      env: {
        LAB_AUTHOR: "1",
        GH_TOKEN: "ghp_worker",
        LAB_API_WORKER: "1",
        LAB_MAIN_CHECKOUT: "/repo",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "url.https://github.com/.insteadOf",
        GIT_CONFIG_VALUE_0: "git@github.com:",
      },
      outputStyle: "Proactive",
      claudeMdExcludes: ["/home/me/.claude/CLAUDE.md"],
      verbose: false,
      apiKeyHelper: "cat '/home/me/.api-agent/key'",
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: 'cd "$LAB_MAIN_CHECKOUT" && bun "$LAB_MAIN_CHECKOUT"/factory/bin/stop-hook.ts',
                timeout: 900,
              },
            ],
          },
        ],
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: 'cd "$LAB_MAIN_CHECKOUT" && bun "$LAB_MAIN_CHECKOUT"/factory/hooks/refuse-author-publish.ts',
                timeout: 30,
                onFailure: "block",
              },
            ],
          },
        ],
      },
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        autoAllowBashIfSandboxed: true,
        credentials: {
          files: [
            { path: "/home/me/.api-agent", mode: "deny" },
            { path: "/home/me/.config/software-factory-lab", mode: "deny" },
          ],
        },
        network: {
          allowedDomains: ["github.com", "*.github.com", "*.githubusercontent.com", "registry.npmjs.org"],
        },
      },
      permissions: { allow: ["Edit(./**)", "Bash"], deny: DENY },
    });
  });

  test("no hook names the session's own checkout, which is the worktree the Worker edits, and each starts in the main checkout, where `bun` reads no file of the Worker's", () => {
    const settings = textOf(JSON.stringify(worker));

    expect(settings).not.toContain("CLAUDE_PROJECT_DIR");
    expect(CHECKOUT_VARIABLE).toBe("LAB_MAIN_CHECKOUT");

    const commands = [...settings.matchAll(/"command": "(?<command>[^\n]*)",?\n/gu)].map(
      (match) => match.groups?.["command"] ?? "",
    );

    expect(commands).toHaveLength(2);
    expect(commands.every((command) => command.startsWith(String.raw`cd \"$LAB_MAIN_CHECKOUT\" && bun `))).toBe(true);
  });

  test.each([
    ['bun "${CLAUDE_PROJECT_DIR}"/factory/hooks/role.ts', "another spelling of the variable"],
    ["bun factory/hooks/role.ts", "a path from the session's own directory"],
    ['bun "$CLAUDE_PROJECT_DIR"/factory/hooks/role.ts --flag', "an argument"],
    ['bun "$CLAUDE_PROJECT_DIR"/../outside.ts', "a path that leaves the checkout"],
    ['bun "$CLAUDE_PROJECT_DIR"/factory/hooks/role.ts; true', "a second command"],
    ['node "$CLAUDE_PROJECT_DIR"/factory/hooks/role.ts', "another runner"],
    [
      'cd "$CLAUDE_PROJECT_DIR" && bun "$CLAUDE_PROJECT_DIR"/factory/hooks/role.ts',
      "a start in the session's checkout",
    ],
  ])(
    "a hook command the rewrite cannot read (%s: %s) throws, naming it: none runs as it stands, where it could run a file of the worktree",
    (command) => {
      const project = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } });

      expect(() => apiWorkerSettingsTextOf(JSON.stringify(worker), project, PLACE)).toThrow(
        `the main checkout's .claude/settings.json: the hook command \`${command}\` is not \`bun "$CLAUDE_PROJECT_DIR"/<file>\``,
      );
    },
  );

  test.each([
    [{ hooks: [{ type: "prompt", prompt: "is it done?" }] }, '["hooks"][0]["command"]', "a hook that is no command"],
    [{ matcher: "Bash" }, '["hooks"]', "a group with no hooks"],
  ])("%j throws, naming the key it lacks (%s: %s): an API Worker's settings carry commands alone", (group, missing) => {
    const project = JSON.stringify({ hooks: { Stop: [group] } });

    expect(() => apiWorkerSettingsTextOf(JSON.stringify(worker), project, PLACE)).toThrow(
      `the main checkout's .claude/settings.json: Missing key\n  at ["hooks"]["Stop"][0]${missing}`,
    );
  });

  test("it takes the main checkout's hooks alone: no plugin, no other key of its settings", () => {
    const settings = textOf(JSON.stringify(worker));

    expect(settings).not.toContain("enabledPlugins");
    expect(settings).not.toContain("baseRef");
  });

  test("the key itself is nowhere in it, nor any variable that would hold one, nor the scrub", () => {
    const settings = textOf(JSON.stringify(worker));

    expect(settings).not.toContain("ANTHROPIC");
    expect(settings).not.toContain("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB");
    expect(settings).not.toContain("sk-ant");
  });

  test("the rules the Worker settings file holds stay, before the API Worker's own, with every other key of its permissions", () => {
    const held = {
      ...worker,
      permissions: { allow: ["Bash(jq *)"], deny: ["Read(./secrets/**)"], ask: ["Bash(rm *)"] },
    };

    expect(JSON.parse(textOf(JSON.stringify(held)))).toMatchObject({
      permissions: {
        allow: ["Bash(jq *)", "Edit(./**)", "Bash"],
        deny: ["Read(./secrets/**)", ...DENY],
        ask: ["Bash(rm *)"],
      },
    });
    expect(JSON.parse(textOf(JSON.stringify({ ...worker, permissions: { deny: ["Read(./x)"] } })))).toMatchObject({
      permissions: {
        allow: ["Edit(./**)", "Bash"],
        deny: ["Read(./x)", ...DENY],
      },
    });
  });

  test("a helper, a marker, hooks or a sandbox the Worker settings file holds give way to the API Worker's", () => {
    const held = {
      ...worker,
      apiKeyHelper: "echo other",
      verbose: true,
      hooks: { Stop: [] },
      sandbox: { enabled: false, excludedCommands: ["git *"] },
      env: { ...worker.env, LAB_API_WORKER: "0", LAB_MAIN_CHECKOUT: "/elsewhere", GIT_CONFIG_COUNT: "0" },
    };

    const settings = textOf(JSON.stringify(held));

    expect(JSON.parse(settings)).toMatchObject({
      apiKeyHelper: "cat '/home/me/.api-agent/key'",
      verbose: false,
      env: { LAB_API_WORKER: "1", LAB_MAIN_CHECKOUT: "/repo", GIT_CONFIG_COUNT: "1" },
      sandbox: { enabled: true },
    });
    expect(settings).not.toContain("excludedCommands");
    expect(settings).toContain("stop-hook.ts");
  });

  test("a Worker settings file that does not read throws, naming it", () => {
    expect(() => textOf('{"env":{},"permissions":{"allow":"Bash(jq *)"}}')).toThrow("the Worker settings file: ");
    expect(() => textOf('{"env":{},"permissions":{"deny":[1]}}')).toThrow("the Worker settings file: ");
    expect(() => textOf("{")).toThrow("the Worker settings file: ");
    expect(() => textOf('{"env":{"LAB_AUTHOR":1}}')).toThrow("the Worker settings file: ");
  });

  test("a main checkout whose settings hold no hooks, or do not read, throws: an API Worker with no Stop hook publishes nothing", () => {
    const author = '{"env":{"LAB_AUTHOR":"1","GH_TOKEN":"t"}}';

    expect(() => apiWorkerSettingsTextOf(author, '{"enabledPlugins":{}}', PLACE)).toThrow(
      "the main checkout's .claude/settings.json: ",
    );
    expect(() => apiWorkerSettingsTextOf(author, "{", PLACE)).toThrow("the main checkout's .claude/settings.json: ");
  });

  test("the main checkout's settings file is the one Claude Code reads there", () => {
    expect(projectSettingsOf("/repo")).toBe("/repo/.claude/settings.json");
  });
});

describe("apiKeyProblemOf", () => {
  test("a key file only its owner reads does", () => {
    expect(apiKeyProblemOf(0o600)).toBeNull();
    expect(apiKeyProblemOf(0o400)).toBeNull();
  });

  test("a missing key file does not", () => {
    expect(apiKeyProblemOf(null)).toBe("is missing");
  });

  test.each([0o640, 0o604, 0o644, 0o660, 0o602, 0o610, 0o601])(
    "a key file its group or others reach (mode %o) does not",
    (mode) => {
      expect(apiKeyProblemOf(mode)).toBe("is readable by its group or by others: set its mode to 600");
    },
  );
});

describe("the launch of an API Worker", () => {
  test("its session carries the issue's name, as a background Worker's does", () => {
    expect(sessionNameOf(168)).toBe("w-issue-168");
  });

  test("its worktree gets its dependencies as copies, with no lifecycle script, from the lockfile as it stands", () => {
    expect(INSTALL_ARGV).toEqual(["bun", "install", "--frozen-lockfile", "--ignore-scripts", "--backend=copyfile"]);
  });

  test("a first turn that still runs after the look, or that ended well, has no problem; one that ended with an error names its log", () => {
    expect(firstTurnProblemOf(null, "/repo/.lab/state/s.log")).toBeNull();
    expect(firstTurnProblemOf(0, "/repo/.lab/state/s.log")).toBeNull();
    expect(firstTurnProblemOf(1, "/repo/.lab/state/s.log")).toBe(
      "the API Worker's first turn ended at once with exit 1: /repo/.lab/state/s.log holds what it printed",
    );
    expect(firstTurnProblemOf(124, "/l")).toBe(
      "the API Worker's first turn ended at once with exit 124: /l holds what it printed",
    );
  });
});

describe("launchArgvOf", () => {
  test("launches a named background session with the Worker settings passed by path", () => {
    expect(
      launchArgvOf({ issue: 168, model: "opus", effort: undefined, settings: "/h/worker-settings.json", prompt: "P" }),
    ).toEqual([
      "claude",
      "--bg",
      "--model",
      "opus",
      "--settings",
      "/h/worker-settings.json",
      "--name",
      "w-issue-168",
      "P",
    ]);
  });

  test("passes the effort after the model when one is named", () => {
    expect(
      launchArgvOf({ issue: 168, model: "opus", effort: "xhigh", settings: "/h/worker-settings.json", prompt: "P" }),
    ).toEqual([
      "claude",
      "--bg",
      "--model",
      "opus",
      "--effort",
      "xhigh",
      "--settings",
      "/h/worker-settings.json",
      "--name",
      "w-issue-168",
      "P",
    ]);
  });
});

describe("sessionIdOf", () => {
  test("is the id in the `claude stop <id>` hint `claude --bg` prints last", () => {
    expect(sessionIdOf("claude stop 393c369e      stop this session\n")).toBe("393c369e");
  });

  test("finds the hint among the other lines `claude --bg` prints", () => {
    expect(
      sessionIdOf(
        "Started w-issue-171 in the background.\n  claude attach 393c369e    attach\n  claude stop 393c369e      stop this session\n",
      ),
    ).toBe("393c369e");
  });

  test("refuses an output with no `claude stop` hint", () => {
    expect(() => sessionIdOf("Started.\n393c369e\n")).toThrow("printed no session id");
  });
});

describe("workerSettingsProblemOf", () => {
  test("accepts settings that make an Author with a token", () => {
    expect(workerSettingsProblemOf('{"env":{"LAB_AUTHOR":"1","GH_TOKEN":"t"},"outputStyle":"Proactive"}')).toBeNull();
  });

  test.each([
    ["{", "is not JSON with an env of strings"],
    ["[]", "is not JSON with an env of strings"],
    ['{"env":{"LAB_AUTHOR":1,"GH_TOKEN":"t"}}', "is not JSON with an env of strings"],
    ['{"env":{"GH_TOKEN":"t"}}', 'env.LAB_AUTHOR is not "1"'],
    ['{"env":{"LAB_AUTHOR":"1"}}', "env.GH_TOKEN is not set"],
    ['{"env":{"LAB_AUTHOR":"1","GH_TOKEN":""}}', "env.GH_TOKEN is not set"],
  ])("refuses %s: %s", (text, problem) => {
    expect(workerSettingsProblemOf(text)).toBe(problem);
  });

  test("never quotes the file, which holds the token", () => {
    expect(workerSettingsProblemOf('{"env":{"LAB_AUTHOR":"0","GH_TOKEN":"ghp_secret"}}')).not.toContain("ghp_secret");
    expect(workerSettingsProblemOf('{"env":{"GH_TOKEN":"ghp_secret"')).not.toContain("ghp_secret");
  });
});
