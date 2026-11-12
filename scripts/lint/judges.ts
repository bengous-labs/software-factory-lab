/**
 * `local/judges`: a Judge's settings live in its actor file (`factory/land/AGENTS.md`). A Judge reaches
 * Claude Code through one of the two doors to the Agent SDK, whose ports take its settings as one
 * field, `judgeSettings`, or as a `claude -p` fork. In `factory/`, tests and fixtures aside, the rule reads the
 * syntax tree and refuses:
 *
 * - a `judgeSettings` property whose value is not a constant imported from an actor file, whether written out,
 *   as a shorthand or under a quoted or constant computed key, and a spread or a key computed at run time
 *   after it in the same object, which could override it;
 * - outside the actor files and the doors, a key that names a Judge's tools or permissions, and a model
 *   written as a string;
 * - a fork's tool or permission flag in a string, but `--tools` or `--permission-mode` as an element of a
 *   command whose next element reads an actor file's constant; a `claude -p` command without `--tools`;
 *   and a flag that lifts the permissions;
 * - outside the doors, any string that names the Agent SDK, an import's included.
 *
 * It reads what the source writes: a value built at run time, such as an object passed through
 * `Object.assign` or a key computed from a variable in an object that holds no `judgeSettings`, is out of its
 * sight. The typecheck holds the ports' shape, and the tool guard denies a write at call time.
 */

import { posix } from "node:path";

import type { Context, ESTree, Scope, Variable } from "@oxlint/plugins";
import { defineRule } from "@oxlint/plugins";

/** The doors to the Agent SDK, from the repository root: each passes the settings of the call it is handed. */
export const SDK_DOORS = ["factory/land/review/review-session.live.ts", "factory/land/shared/ask.live.ts"];

const SDK = "@anthropic-ai/claude-agent-sdk";

/** The field of a Judge's port that carries its settings. */
const JUDGE = "judgeSettings";

/** The keys of a Judge's tools and permissions, which only its actor file and the doors write. */
const SETTING_KEYS = ["tools", "allowedTools", "disallowedTools", "permissionMode"];

/** A flag of `claude` that sets a fork's tools or permissions. */
const SETTING_FLAG =
  /--(?:tools|allowedTools|allowed-tools|disallowedTools|disallowed-tools|permission-mode|(?:allow-)?dangerously-skip-permissions)(?![\w-])/u;

/** The flags a fork's command may hold, each followed by an actor file's constant. */
const FORK_FLAGS = ["--tools", "--permission-mode"];

const WHY = "A Judge's settings live in its actor file (`factory/land/AGENTS.md`).";

const slashed = (path: string): string => path.replaceAll("\\", "/");

const REPO_ROOT = posix.join(slashed(import.meta.dirname), "..", "..");

/** The path from the repository root, whatever directory oxlint runs from; a file outside it reads from that directory. */
function relativePath(context: Context): string {
  const fromRoot = posix.relative(REPO_ROOT, slashed(context.filename));

  return fromRoot.startsWith("../") ? posix.relative(slashed(context.cwd), slashed(context.filename)) : fromRoot;
}

/** The variable `identifier` names in its scope or one above it; null for a global. */
function variableOf(context: Context, identifier: ESTree.Node & { readonly name: string }): Variable | null {
  for (let scope: Scope | null = context.sourceCode.getScope(identifier); scope !== null; scope = scope.upper) {
    const found = scope.set.get(identifier.name);

    if (found !== undefined) {
      return found;
    }
  }

  return null;
}

/** Whether `node` names a binding imported from an actor file. */
function isActorImport(context: Context, node: ESTree.Node): boolean {
  if (node.type !== "Identifier") {
    return false;
  }

  const definition = variableOf(context, node)?.defs[0];

  return (
    definition?.type === "ImportBinding" &&
    definition.parent?.type === "ImportDeclaration" &&
    definition.parent.source.value.endsWith(".actor.ts")
  );
}

/** The binding an expression starts from: `A` of `A.b.c(…)`; null for any other root. */
function rootOf(node: ESTree.Node): ESTree.Node | null {
  if (node.type === "MemberExpression") {
    return rootOf(node.object);
  }

  if (node.type === "CallExpression") {
    return rootOf(node.callee);
  }

  return node.type === "Identifier" ? node : null;
}

/** Whether `node` is a string written with quotes, read by its source text as `layers.ts` does. */
const isStringLiteral = (node: ESTree.Node): node is ESTree.StringLiteral =>
  node.type === "Literal" && /^["']/u.test(node.raw ?? "");

/** The string an expression holds when the source writes it: a string, a template with no hole, or a `const` bound to one. */
function constantString(context: Context, node: ESTree.Node): string | null {
  if (isStringLiteral(node)) {
    return node.value;
  }

  if (node.type === "TemplateLiteral") {
    return node.expressions.length === 0 ? (node.quasis[0]?.value.cooked ?? null) : null;
  }

  if (node.type !== "Identifier") {
    return null;
  }

  const definition = variableOf(context, node)?.defs[0];
  const declarator = definition?.type === "Variable" ? definition.node : null;

  return declarator?.type === "VariableDeclarator" &&
    definition?.parent?.type === "VariableDeclaration" &&
    definition.parent.kind === "const" &&
    declarator.init !== null
    ? constantString(context, declarator.init)
    : null;
}

/** A property's key as the source writes it; null when it is computed at run time. */
function keyOf(context: Context, property: ESTree.ObjectProperty): string | null {
  if (!property.computed && property.key.type === "Identifier") {
    return property.key.name;
  }

  return property.key.type === "PrivateIdentifier" ? null : constantString(context, property.key);
}

/** Whether an object's property is a key computed at run time. */
const runTimeKey = (context: Context, part: ESTree.ObjectPropertyKind): boolean =>
  part.type === "Property" && part.computed && keyOf(context, part) === null;

/** The strings a literal or a template holds. */
function stringsOf(node: ESTree.StringLiteral | ESTree.TemplateLiteral): readonly string[] {
  return node.type === "Literal" ? [node.value] : node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw);
}

/** Whether `node` is a fork's flag the rule lets through: an element of a command, followed by an actor file's constant. */
function allowedFlag(context: Context, node: ESTree.StringLiteral | ESTree.TemplateLiteral): boolean {
  if (node.type !== "Literal" || !FORK_FLAGS.includes(node.value) || node.parent.type !== "ArrayExpression") {
    return false;
  }

  const { elements } = node.parent;
  const next = elements[elements.indexOf(node) + 1];
  const root = next === undefined || next === null ? null : rootOf(next);

  return root !== null && isActorImport(context, root);
}

/** The strings an array literal holds, element by element; null for an element that is not one. */
const elementStrings = (context: Context, node: ESTree.ArrayExpression): ReadonlyArray<string | null> =>
  node.elements.map((element) =>
    element === null || element.type === "SpreadElement" ? null : constantString(context, element),
  );

export const judgesRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Keep each Judge's settings in its actor file." },
  },
  create(context) {
    const path = relativePath(context);

    if (!path.startsWith("factory/") || /\.(?:test|fixtures)\.ts$/u.test(path)) {
      return {};
    }

    const door = SDK_DOORS.includes(path);
    const actor = path.endsWith(".actor.ts");

    const report = (node: ESTree.Node, what: string): void => {
      context.report({ node, message: `\`${path}\` ${what}. ${WHY}` });
    };

    const checkStrings = (node: ESTree.StringLiteral | ESTree.TemplateLiteral): void => {
      const strings = stringsOf(node);

      if (!door && strings.some((text) => text.startsWith(SDK))) {
        report(node, "names the Agent SDK, which only its two doors call");
      }

      if (!actor && strings.some((text) => SETTING_FLAG.test(text)) && !allowedFlag(context, node)) {
        report(
          node,
          "writes a flag that sets a fork's tools or permissions: pass `--tools` or `--permission-mode` followed by an actor file's constant",
        );
      }
    };

    return {
      Literal(node) {
        if (isStringLiteral(node)) {
          checkStrings(node);
        }
      },
      TemplateLiteral(node) {
        checkStrings(node);
      },
      ArrayExpression(node) {
        const strings = elementStrings(context, node);

        if (
          !actor &&
          strings[0] === "claude" &&
          strings.some((text) => text === "-p" || text === "--print") &&
          !strings.includes("--tools")
        ) {
          report(node, "runs `claude -p` with no `--tools`, so the fork has every tool");
        }
      },
      ObjectExpression(node) {
        const judgeAt = node.properties.findIndex((part) => part.type === "Property" && keyOf(context, part) === JUDGE);

        for (const [index, part] of node.properties.entries()) {
          if (judgeAt !== -1 && index > judgeAt && (part.type === "SpreadElement" || runTimeKey(context, part))) {
            report(part, "spreads or computes a key after a Judge's `judgeSettings`, which could override it");
          }

          if (part.type !== "Property") {
            continue;
          }

          const key = keyOf(context, part);

          if (key === JUDGE && !isActorImport(context, part.value)) {
            report(part, "passes a Judge's settings that are not a constant imported from an actor file");
          } else if (!actor && !door && key !== null && SETTING_KEYS.includes(key)) {
            report(part, `writes a Judge's \`${key}\` outside an actor file`);
          } else if (!actor && key === "model" && constantString(context, part.value) !== null) {
            report(part, "writes a model as a string outside an actor file");
          }
        }
      },
    };
  },
});
