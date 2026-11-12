import { describe, expect, test } from "bun:test";

import {
  branchOf,
  dispatchArgsOf,
  issueBranchesIn,
  launchArgvOf,
  launchEnvOf,
  promptOf,
  repoOfIssueUrl,
  sessionIdOf,
  slugOf,
  workerSettingsOf,
  workerSettingsProblemOf,
  worktreeListed,
  worktreeOf,
} from "./dispatch-plan.ts";

describe("dispatchArgsOf", () => {
  test("takes the issue and launches on opus by default", () => {
    expect(dispatchArgsOf(["168"])).toStrictEqual({ issue: 168, model: "opus", effort: undefined });
  });

  test("takes the model --model names, before or after the issue", () => {
    expect(dispatchArgsOf(["168", "--model", "sonnet"])).toEqual({ issue: 168, model: "sonnet", effort: undefined });
    expect(dispatchArgsOf(["--model", "fable", "7"])).toEqual({ issue: 7, model: "fable", effort: undefined });
  });

  test.each(["low", "medium", "high", "xhigh", "max"] as const)("takes the effort --effort %s names", (effort) => {
    expect(dispatchArgsOf(["168", "--effort", effort])).toEqual({ issue: 168, model: "opus", effort });
  });

  test("combines --model and --effort in either order", () => {
    const expected = { issue: 7, model: "sonnet", effort: "low" } as const;
    expect(dispatchArgsOf(["7", "--model", "sonnet", "--effort", "low"])).toEqual(expected);
    expect(dispatchArgsOf(["--effort", "low", "--model", "sonnet", "7"])).toEqual(expected);
    expect(dispatchArgsOf(["--effort", "low", "7", "--model", "sonnet"])).toEqual(expected);
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
  ])("refuses %j with the usage", (argv) => {
    expect(() => dispatchArgsOf(argv)).toThrow(
      "usage: bun factory/bin/dispatch.ts <issue> [--model <model>] [--effort <low|medium|high|xhigh|max>]",
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
  test("names the issue, how to read it, the worktree and its branch, and nothing a Worker's instructions give", () => {
    expect(
      promptOf({
        issue: 168,
        repo: "o/r",
        worktree: "/repo/.claude/worktrees/issue-168",
        branch: "issue/168-x",
      }),
    ).toBe(
      "Implement GitHub issue #168 of o/r (read it with: gh issue view 168 --repo o/r). Your worktree exists: first call EnterWorktree with the path /repo/.claude/worktrees/issue-168 and work there; its branch issue/168-x starts at origin/dev.",
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

describe("launchEnvOf", () => {
  test("keeps what Claude Code needs to reach the API, proxies in either case", () => {
    const reach = {
      HTTPS_PROXY: "http://p",
      HTTP_PROXY: "http://p",
      ALL_PROXY: "socks5://p",
      NO_PROXY: "localhost",
      https_proxy: "http://p",
      http_proxy: "http://p",
      all_proxy: "socks5://p",
      no_proxy: "localhost",
      NODE_EXTRA_CA_CERTS: "/ca.pem",
      TMPDIR: "/tmp/x",
      XDG_CONFIG_HOME: "/h/.config",
    };

    expect(launchEnvOf({ ...reach, GH_TOKEN: "t" })).toEqual(reach);
  });

  test("keeps no API credential of the caller, which the Worker could read with env", () => {
    expect(launchEnvOf({ HOME: "/h", ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "o" })).toEqual({ HOME: "/h" });
  });

  test("keeps only what a session needs to start, so no token or Author marker of the caller reaches it", () => {
    expect(
      launchEnvOf({ HOME: "/h", PATH: "/bin", GH_TOKEN: "t", LAB_AUTHOR: "1", CLAUDECODE: "1", LANG: undefined }),
    ).toEqual({ HOME: "/h", PATH: "/bin" });
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
