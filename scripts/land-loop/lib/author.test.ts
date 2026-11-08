import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { AUTHOR_TOKEN_PATH, authorTokenOf, authorTokenPathOf, ghEnv, pushArgs, requiredAuthorToken } from "./author.ts";

const dir = (): string => mkdtempSync(join(tmpdir(), "author-"));

describe("authorTokenOf", () => {
  test("reads the file LAB_AUTHOR_TOKEN_FILE names, trimmed", () => {
    const path = join(dir(), "token");
    writeFileSync(path, "  github_pat_x \n");

    expect(authorTokenOf({ LAB_AUTHOR_TOKEN_FILE: path })).toEqual({ kind: "found", token: "github_pat_x" });
  });

  test("a missing, unreadable or empty file is missing, naming its path", () => {
    const missing = join(dir(), "absent");
    const directory = dir();
    const empty = join(dir(), "token");
    writeFileSync(empty, " \n");

    expect(authorTokenOf({ LAB_AUTHOR_TOKEN_FILE: missing })).toEqual({ kind: "missing", path: missing });
    expect(authorTokenOf({ LAB_AUTHOR_TOKEN_FILE: directory })).toEqual({ kind: "missing", path: directory });
    expect(authorTokenOf({ LAB_AUTHOR_TOKEN_FILE: empty })).toEqual({ kind: "missing", path: empty });
  });

  test("with LAB_AUTHOR_TOKEN_FILE unset, the default path under HOME is read", () => {
    expect(AUTHOR_TOKEN_PATH).toBe(join(homedir(), ".config", "software-factory-lab", "author-token"));
    expect(isAbsolute(AUTHOR_TOKEN_PATH)).toBe(true);
    expect(authorTokenPathOf({})).toBe(AUTHOR_TOKEN_PATH);
    expect(authorTokenPathOf({ LAB_AUTHOR_TOKEN_FILE: "/elsewhere/token" })).toBe("/elsewhere/token");
  });
});

describe("requiredAuthorToken", () => {
  test("gives the token found, and throws, naming the path, when there is none", () => {
    const path = join(dir(), "token");
    writeFileSync(path, "t0k\n");
    const missing = join(dir(), "absent");

    expect(requiredAuthorToken({ LAB_AUTHOR_TOKEN_FILE: path })).toBe("t0k");
    expect(() => requiredAuthorToken({ LAB_AUTHOR_TOKEN_FILE: missing })).toThrow(
      `no Author token at ${missing}: the Owner provisions it (AGENTS.md, Identities); nothing was posted`,
    );
  });
});

describe("the Author's credential", () => {
  test("gh writes with GH_TOKEN set to the token", () => {
    expect(ghEnv("t0k")).toEqual({ GH_TOKEN: "t0k" });
  });

  test("the push rewrites the scp-form git@github.com: origin to HTTPS with the token from LAB_AUTHOR_TOKEN", () => {
    expect(pushArgs("feat/95-x")).toEqual([
      "git",
      "-c",
      "url.https://github.com/.pushInsteadOf=git@github.com:",
      "-c",
      "credential.https://github.com.helper=",
      "-c",
      'credential.https://github.com.helper=!f() { echo username=x-access-token; echo "password=$LAB_AUTHOR_TOKEN"; }; f',
      "push",
      "--force-with-lease",
      "-u",
      "origin",
      "HEAD:refs/heads/feat/95-x",
    ]);
  });
});
