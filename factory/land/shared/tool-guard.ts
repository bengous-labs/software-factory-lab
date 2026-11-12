/**
 * The tool guards of the review job, the Routing judge and the Stop hook forks: every tool call of their
 * sessions is allowed or denied here, by code, and anything a guard does not know is denied. A session reads
 * only under its checkout, outside `.git`, and runs one read-only git command per Bash call. Paths reach
 * the guard through `resolve`, which follows every link, so a link the pull request commits is judged
 * by where it leads.
 */

import { Option, Schema } from "effect";

import type { ToolDecision, ToolGuard } from "./review.port.ts";

const ALLOW: ToolDecision = { kind: "allow" };

const deny = (reason: string): ToolDecision => ({ kind: "deny", reason });

export const BASH_REASON =
  "one read-only git command from the allowed list per call, no shell operators or quotes; use Read and Grep for files";

export const PATH_REASON = "read only inside the checkout you work in, outside .git";

const GLOB_REASON = "a Glob pattern is relative to the checkout, with no `..` segment";

/** The characters a token of an allowed git command may hold: no shell operator, quote, glob or expansion. */
const TOKEN = /^[A-Za-z0-9._/:@^~=,+%-]+$/u;

const NUMBER = /^\d+$/u;

interface GitRule {
  /** Options that stand alone. */
  readonly flags: ReadonlySet<string>;
  /** Options that carry their value in the same token, such as `-U5` or `--format=%h`. */
  readonly attached: readonly RegExp[];
  /** Options whose value is the next token, with the pattern that value must match. */
  readonly valued: ReadonlyMap<string, RegExp>;
}

const rule = (
  flags: readonly string[],
  attached: readonly RegExp[] = [],
  valued: ReadonlyArray<readonly [string, RegExp]> = [],
): GitRule => ({
  flags: new Set(flags),
  attached,
  valued: new Map(valued),
});

/** The read-only git subcommands, each with the options it admits; any other option is refused. */
const GIT_RULES: ReadonlyMap<string, GitRule> = new Map([
  [
    "diff",
    rule(
      [
        "--stat",
        "--name-only",
        "--name-status",
        "--numstat",
        "--shortstat",
        "--cached",
        "--staged",
        "-w",
        "-b",
        "--no-color",
        "--no-renames",
        "-M",
        "--find-renames",
        "--patience",
        "--histogram",
        "--summary",
        "--",
      ],
      [/^-U\d+$/u, /^--unified=\d+$/u, /^--stat=\d+(,\d+)?$/u, /^--diff-filter=[ACDMRTUXB]+$/iu],
    ),
  ],
  [
    "log",
    rule(
      [
        "--oneline",
        "--stat",
        "-p",
        "--patch",
        "--follow",
        "--no-merges",
        "--merges",
        "--first-parent",
        "--reverse",
        "--name-only",
        "--name-status",
        "--decorate",
        "--no-decorate",
        "--all",
        "--abbrev-commit",
        "--no-color",
        "--shortstat",
        "--numstat",
        "--",
      ],
      [
        /^-\d+$/u,
        /^-n\d+$/u,
        /^--max-count=\d+$/u,
        /^--skip=\d+$/u,
        /^--format=./u,
        /^--pretty=./u,
        /^--since=./u,
        /^--until=./u,
        /^--author=./u,
        /^--grep=./u,
        /^-S./u,
        /^-G./u,
        /^-U\d+$/u,
      ],
      [["-n", NUMBER]],
    ),
  ],
  [
    "show",
    rule(
      [
        "--stat",
        "--name-only",
        "--name-status",
        "--no-patch",
        "-s",
        "--oneline",
        "--no-color",
        "--shortstat",
        "--numstat",
        "--abbrev-commit",
        "--",
      ],
      [/^--format=./u, /^--pretty=./u, /^-U\d+$/u, /^--unified=\d+$/u],
    ),
  ],
  ["blame", rule(["-w", "-s", "--"], [/^-L\d+,\+?\d+$/u], [["-L", /^\d+,\+?\d+$/u]])],
  ["ls-files", rule(["--cached", "-c", "-s", "--stage", "--deleted", "-d", "--modified", "-m", "--"])],
  [
    "rev-parse",
    rule(["--abbrev-ref", "--short", "--verify", "--symbolic-full-name", "--show-toplevel"], [/^--short=\d+$/u]),
  ],
  ["merge-base", rule(["--is-ancestor", "--all", "--octopus", "--independent"])],
  ["status", rule(["--short", "-s", "--porcelain", "--branch", "-b", "-uno", "--untracked-files=no", "--no-renames"])],
  [
    "grep",
    rule(
      [
        "-n",
        "--line-number",
        "-i",
        "--ignore-case",
        "-w",
        "--word-regexp",
        "-l",
        "--files-with-matches",
        "-L",
        "--files-without-match",
        "-c",
        "--count",
        "-F",
        "--fixed-strings",
        "-E",
        "--extended-regexp",
        "-I",
        "--cached",
        "-h",
        "-H",
        "--heading",
        "--break",
        "-p",
        "--show-function",
        "--",
      ],
      [/^-[ABC]\d+$/u, /^--(after-|before-)?context=\d+$/u, /^--max-depth=\d+$/u],
      [
        ["-e", TOKEN],
        ["-A", NUMBER],
        ["-B", NUMBER],
        ["-C", NUMBER],
      ],
    ),
  ],
]);

/** A revision or a path: no option, no absolute or home path, no `..` segment. A range such as `a...b` has none. */
function plainArgument(token: string): boolean {
  return !token.startsWith("-") && !token.startsWith("/") && !token.startsWith("~") && !token.split("/").includes("..");
}

function optionsAllowed(gitRule: GitRule, tokens: readonly string[]): boolean {
  const [token, ...rest] = tokens;

  if (token === undefined) {
    return true;
  }

  const valuePattern = gitRule.valued.get(token);

  if (valuePattern !== undefined) {
    const [value, ...after] = rest;

    return value !== undefined && valuePattern.test(value) && optionsAllowed(gitRule, after);
  }

  const known = gitRule.flags.has(token) || gitRule.attached.some((pattern) => pattern.test(token));

  return (known || plainArgument(token)) && optionsAllowed(gitRule, rest);
}

/** One git subcommand from `GIT_RULES`, with only its options, and no global option but `--no-pager`. */
export function bashGuard(command: string): ToolDecision {
  const tokens = command.split(" ").filter((token) => token !== "");

  if (!tokens.every((token) => TOKEN.test(token))) {
    return deny(BASH_REASON);
  }

  const [program, ...rest] = tokens;
  const [subcommand = "", ...options] = rest[0] === "--no-pager" ? rest.slice(1) : rest;
  const gitRule = GIT_RULES.get(subcommand);

  return program === "git" && gitRule !== undefined && optionsAllowed(gitRule, options) ? ALLOW : deny(BASH_REASON);
}

/** True when `resolved`, a path with every link followed, is `root` or under it, and never `root/.git` or under it. */
export function pathGuard(resolved: string, root: string): boolean {
  if (resolved === root) {
    return true;
  }

  const rest = resolved.startsWith(`${root}/`) ? resolved.slice(root.length + 1) : null;

  return rest !== null && rest !== ".git" && !rest.startsWith(".git/");
}

/** Resolves a tool's path against the checkout, every link followed; null when it does not resolve. */
export type Resolve = (path: string) => string | null;

export interface GuardScope {
  /** The checkout of the pull request's head, resolved. */
  readonly root: string;
  readonly resolve: Resolve;
}

/** Agent options that would run a subagent elsewhere or under other permissions. */
const AGENT_REFUSED = ["isolation", "mode", "team_name"] as const;

const ReadInput = Schema.Struct({ file_path: Schema.String });

const PathInput = Schema.Struct({ path: Schema.optional(Schema.String) });

const GlobInput = Schema.Struct({ pattern: Schema.String, path: Schema.optional(Schema.String) });

const BashInput = Schema.Struct({ command: Schema.String });

const SkillInput = Schema.Struct({ skill: Schema.Literal("code-review") });

const decoded = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: Schema.JsonObject,
): Option.Option<S["Type"]> => Schema.decodeUnknownOption(schema)(input);

function pathDecision(scope: GuardScope, path: string | undefined): ToolDecision {
  const resolved = scope.resolve(path ?? scope.root);

  return resolved !== null && pathGuard(resolved, scope.root) ? ALLOW : deny(PATH_REASON);
}

function globDecision(scope: GuardScope, input: Schema.JsonObject): ToolDecision {
  return Option.match(decoded(GlobInput, input), {
    onNone: () => deny(GLOB_REASON),
    onSome: (glob) => (plainArgument(glob.pattern) ? pathDecision(scope, glob.path) : deny(GLOB_REASON)),
  });
}

function agentDecision(input: Schema.JsonObject): ToolDecision {
  const refused = AGENT_REFUSED.filter((key) => Object.hasOwn(input, key));

  return refused.length === 0 ? ALLOW : deny(`an Agent call takes no ${AGENT_REFUSED.join(", ")}`);
}

/** The decision of a read tool, a Bash call or the structured answer; any other tool is denied with `refused`. */
function readDecision(scope: GuardScope, toolName: string, input: Schema.JsonObject, refused: string): ToolDecision {
  switch (toolName) {
    case "Read": {
      return Option.match(decoded(ReadInput, input), {
        onNone: () => deny(PATH_REASON),
        onSome: (read) => pathDecision(scope, read.file_path),
      });
    }

    case "Grep": {
      return Option.match(decoded(PathInput, input), {
        onNone: () => deny(PATH_REASON),
        onSome: (grep) => pathDecision(scope, grep.path),
      });
    }

    case "Glob": {
      return globDecision(scope, input);
    }

    case "Bash": {
      return Option.match(decoded(BashInput, input), {
        onNone: () => deny(BASH_REASON),
        onSome: (bash) => bashGuard(bash.command),
      });
    }

    case "StructuredOutput": {
      return ALLOW;
    }

    default: {
      return deny(refused);
    }
  }
}

/** The guard of a read-only session over the checkout `scope.root`: Read, Grep, Glob, git and the structured answer. */
export function readGuardOf(scope: GuardScope): ToolGuard {
  return (toolName, input) => readDecision(scope, toolName, input, `the tool ${toolName} is not admitted here`);
}

/** The guard of one review session over the checkout `scope.root`: the read-only guard, plus Agent and the code-review skill. */
export function guardOf(scope: GuardScope): ToolGuard {
  return (toolName, input) => {
    switch (toolName) {
      case "Agent": {
        return agentDecision(input);
      }

      case "Skill": {
        return Option.isSome(decoded(SkillInput, input)) ? ALLOW : deny("only the code-review skill runs here");
      }

      default: {
        return readDecision(scope, toolName, input, `the tool ${toolName} is not admitted in this review`);
      }
    }
  };
}
