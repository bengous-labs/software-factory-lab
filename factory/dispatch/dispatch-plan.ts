/**
 * What Dispatch decides when it hands an issue to a Worker: the branch and the worktree it creates, the
 * one launch prompt, and the `claude --bg` command that starts the Worker in the main checkout.
 */

import { Result, Schema } from "effect";

import { branchMadeFor } from "../contract.ts";
import { CONFIG_DIR, TRUNK } from "../install/host.ts";

export interface DispatchArgs {
  readonly issue: number;
  readonly model: string;
}

const USAGE = "usage: bun factory/bin/dispatch.ts <issue> [--model <model>]";

/** The issue and the model `argv` names; throws the usage on anything else. */
export function dispatchArgsOf(argv: readonly string[]): DispatchArgs {
  const flag = argv.indexOf("--model");
  const model = flag === -1 ? "opus" : argv[flag + 1];
  const rest = flag === -1 ? argv : argv.filter((_, index) => index !== flag && index !== flag + 1);
  const [issue] = rest;

  if (model === undefined || model.startsWith("--") || rest.length !== 1 || issue === undefined) {
    throw new Error(USAGE);
  }

  if (!/^[1-9]\d*$/u.test(issue)) {
    throw new Error(USAGE);
  }

  return { issue: Number(issue), model };
}

const SLUG_MAX = 40;

/** The title's words in lower case joined by dashes, cut at a word to at most 40 characters. */
export function slugOf(title: string): string {
  const words = title.toLowerCase().match(/[a-z0-9]+/gu) ?? [];

  const overflow = words.findIndex((_, index) => words.slice(0, index + 1).join("-").length > SLUG_MAX);
  const kept = overflow === -1 ? words : words.slice(0, overflow);
  const slug = kept.length === 0 ? (words[0]?.slice(0, SLUG_MAX) ?? "") : kept.join("-");

  return slug === "" ? "issue" : slug;
}

/** `issue/<n>-<slug>`: the Stop hook reads a branch `<type>/<n>-…` as made for issue n, and closes it. */
export function branchOf(issue: number, title: string): string {
  return `issue/${issue}-${slugOf(title)}`;
}

export function worktreeOf(checkout: string, issue: number): string {
  return `${checkout}/.claude/worktrees/issue-${issue}`;
}

/** The Worker settings file `factory/install/AGENTS.md` describes, which the Owner provisions. */
export function workerSettingsOf(home: string): string {
  return `${home}/.config/${CONFIG_DIR}/worker-settings.json`;
}

/**
 * Why the Worker settings file would not make the Worker an Author with the machine account's token,
 * or null when it does. The file holds the token: no problem quotes it.
 */
export function workerSettingsProblemOf(text: string): string | null {
  const decoded = Schema.decodeResult(Schema.fromJsonString(WorkerSettings))(text);

  if (Result.isFailure(decoded)) {
    return "is not JSON with an env of strings";
  }

  const { LAB_AUTHOR, GH_TOKEN } = decoded.success.env;

  if (LAB_AUTHOR !== "1") {
    return 'env.LAB_AUTHOR is not "1"';
  }

  return GH_TOKEN === undefined || GH_TOKEN === "" ? "env.GH_TOKEN is not set" : null;
}

const WorkerSettings = Schema.Struct({
  env: Schema.Struct({ LAB_AUTHOR: Schema.optional(Schema.String), GH_TOKEN: Schema.optional(Schema.String) }),
});

/** `owner/name` of the repository of the issue at `url`. */
export function repoOfIssueUrl(url: string): string {
  const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/\d+$/u.exec(url)?.[1];

  if (repo === undefined) {
    throw new Error(`not an issue URL: ${url}`);
  }

  return repo;
}

/** The branches among `refs`, one short ref name a line, that were made for `issue`. */
export function issueBranchesIn(refs: string, issue: number): string[] {
  return refs.split("\n").filter((ref) => branchMadeFor(ref, issue));
}

/** Whether `git worktree list --porcelain` printed `path` among its worktrees. */
export function worktreeListed(listing: string, path: string): boolean {
  return listing.split("\n").includes(`worktree ${path}`);
}

export interface Assignment {
  readonly issue: number;
  readonly repo: string;
  readonly worktree: string;
  readonly branch: string;
}

/**
 * The one launch prompt. It names the issue and the worktree; what a Worker does comes from its own
 * instructions, `AGENTS.md`, never from here.
 */
export function promptOf({ issue, repo, worktree, branch }: Assignment): string {
  return `Implement GitHub issue #${issue} of ${repo} (read it with: gh issue view ${issue} --repo ${repo}). Your worktree exists: first call EnterWorktree with the path ${worktree} and work there; its branch ${branch} starts at origin/${TRUNK}.`;
}

export interface Launch {
  readonly issue: number;
  readonly model: string;
  /** The Worker settings file, passed by its path: its token never reaches the command line. */
  readonly settings: string;
  readonly prompt: string;
}

export function launchArgvOf({ issue, model, settings, prompt }: Launch): string[] {
  return ["claude", "--bg", "--model", model, "--settings", settings, "--name", `w-issue-${issue}`, prompt];
}

/**
 * The variables the launch keeps of the caller's environment: what a session needs to start and to
 * reach the API. No credential: a Worker runs code and could read it with `env`, so it authenticates
 * from `CLAUDE_CONFIG_DIR` or its settings. When this launch starts Claude Code's background service,
 * the service gives its environment to every session started after it, so the caller's `GH_TOKEN`,
 * API credentials, Author marker or session variables stay out of it. A service already running keeps the environment
 * it started with; the Worker settings' `env` still sets the Worker's identity over it.
 */
const KEPT = [
  "HOME",
  "PATH",
  "USER",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "CLAUDE_CONFIG_DIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
];

export function launchEnvOf(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(KEPT.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])));
}

/** The id of the session `claude --bg` started, read from the `claude stop <id>` hint it prints. */
export function sessionIdOf(stdout: string): string {
  const id = /^\s*claude stop (\S+)/mu.exec(stdout)?.[1];

  if (id === undefined) {
    throw new Error(`claude --bg printed no session id: ${stdout.trim()}`);
  }

  return id;
}
