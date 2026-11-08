/**
 * The Author's GitHub credential: the fine-grained token of the machine account
 * `bengous-labs-author`, which every write the Author's code makes on GitHub goes out under.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const AUTHOR_TOKEN_PATH = join(process.env["HOME"] ?? "", ".config", "software-factory-lab", "author-token");

export type AuthorToken =
  { readonly kind: "found"; readonly token: string } | { readonly kind: "missing"; readonly path: string };

type Env = Readonly<Record<string, string | undefined>>;

/** The file `LAB_AUTHOR_TOKEN_FILE` names, or `AUTHOR_TOKEN_PATH` when it is unset. */
export function authorTokenPathOf(env: Env): string {
  return env["LAB_AUTHOR_TOKEN_FILE"] ?? AUTHOR_TOKEN_PATH;
}

/** The token in the file `authorTokenPathOf` gives; a missing, unreadable or empty file is `missing`. */
export function authorTokenOf(env: Env): AuthorToken {
  const path = authorTokenPathOf(env);

  let token: string;

  try {
    token = readFileSync(path, "utf8").trim();
  } catch {
    return { kind: "missing", path };
  }

  return token === "" ? { kind: "missing", path } : { kind: "found", token };
}

/** The token `authorTokenOf` finds; none throws, so a command that posts as the Author posts nothing. */
export function requiredAuthorToken(env: Env): string {
  const author = authorTokenOf(env);

  if (author.kind === "missing") {
    throw new Error(
      `no Author token at ${author.path}: the Owner provisions it (AGENTS.md, Identities); nothing was posted`,
    );
  }

  return author.token;
}

/** The environment of every `gh` call that writes. */
export function ghEnv(token: string) {
  return { GH_TOKEN: token };
}

/**
 * The push of `branch`, run with the environment `{ LAB_AUTHOR_TOKEN: token }`: it rewrites the
 * scp-form `git@github.com:` URL `origin` has, with no `pushurl`, to HTTPS with the token, instead of
 * the SSH key; `origin` itself does not change.
 */
export function pushArgs(branch: string): string[] {
  return [
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
    `HEAD:refs/heads/${branch}`,
  ];
}
