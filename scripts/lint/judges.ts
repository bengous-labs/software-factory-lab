/**
 * `local/judges`: a Judge's settings live in its actor file (`factory/land/AGENTS.md`). A Judge reaches
 * Claude Code through one of the two doors to the Agent SDK, whose ports take its settings as one
 * field, `judgeSettings`, or as a print-mode fork of a session, as the Stop hook's Done judge runs. In
 * `factory/`, tests and fixtures aside, the rule reads the syntax tree, and what it refuses follows from a
 * Judge, never from a key's name alone:
 *
 * - in an object that holds a `judgeSettings`, the call to a Judge: a value that is not a constant
 *   imported from an actor file, whether written out, as a shorthand or under a quoted or constant
 *   computed key; a spread or a key computed at run time after it, which could override it; a model
 *   written as a string, which its actor file or its Review depth names;
 * - in a fork's command, an array that holds `-p` and `--fork-session`: no `--tools`; a tool or permission
 *   flag but `--tools` or `--permission-mode` followed by an actor file's constant, the flags that lift
 *   the permissions included; a spread of anything but an array or a ternary of arrays, which it checks
 *   the same way;
 * - outside the two doors, any string that names the Agent SDK, an import's included: no other path
 *   reaches a model through it.
 *
 * Code that is no Judge's call keeps its keys and its flags: a `tools` or a `model` elsewhere reaches no
 * Judge, since only `judgeSettings` does. A value built at run time, such as an object passed through
 * `Object.assign`, a key computed from a variable in an object without `judgeSettings`, or a fork's
 * command assembled step by step, is out of the rule's sight. The typecheck holds the ports' shape, and
 * the tool guard denies a write at call time.
 */

import { posix } from "node:path";

import type { Context, ESTree, Scope, Variable } from "@oxlint/plugins";
import { defineRule } from "@oxlint/plugins";

/** The doors to the Agent SDK, from the repository root: each passes the settings of the call it is handed. */
export const SDK_DOORS = ["factory/land/review/review-session.live.ts", "factory/land/shared/ask.live.ts"];

const SDK = "@anthropic-ai/claude-agent-sdk";

/** The field of a Judge's port that carries its settings. */
const JUDGE = "judgeSettings";

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

/** Whether an array literal is a Judge's fork: a print-mode fork of a session, as the Stop hook's Done judge runs. */
const isFork = (strings: ReadonlyArray<string | null>): boolean =>
  strings.some((text) => text === "-p" || text === "--print") && strings.includes("--fork-session");

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

    const report = (node: ESTree.Node, what: string): void => {
      context.report({ node, message: `\`${path}\` ${what}. ${WHY}` });
    };

    const checkSdk = (node: ESTree.StringLiteral | ESTree.TemplateLiteral): void => {
      if (!door && stringsOf(node).some((text) => text.startsWith(SDK))) {
        report(node, "names the Agent SDK, which only its two doors call");
      }
    };

    /** Checks the elements of a fork's command, and of each array it spreads, which a ternary may choose. */
    const checkForkElements = (node: ESTree.ArrayExpression): void => {
      for (const element of node.elements) {
        if (element === null) {
          continue;
        }

        if (element.type === "SpreadElement") {
          checkForkSpread(element.argument);
        } else if (
          (isStringLiteral(element) || element.type === "TemplateLiteral") &&
          stringsOf(element).some((text) => SETTING_FLAG.test(text)) &&
          !allowedFlag(context, element)
        ) {
          report(
            element,
            "writes a flag that sets a fork's tools or permissions: pass `--tools` or `--permission-mode` followed by an actor file's constant",
          );
        }
      }
    };

    const checkForkSpread = (spread: ESTree.Expression): void => {
      if (spread.type === "ArrayExpression") {
        checkForkElements(spread);
      } else if (spread.type === "ConditionalExpression") {
        checkForkSpread(spread.consequent);
        checkForkSpread(spread.alternate);
      } else if (spread.type === "ParenthesizedExpression") {
        checkForkSpread(spread.expression);
      } else {
        report(
          spread,
          "spreads into a Judge's fork what the rule cannot read: spread an array, or a ternary of arrays",
        );
      }
    };

    return {
      Literal(node) {
        if (isStringLiteral(node)) {
          checkSdk(node);
        }
      },
      TemplateLiteral(node) {
        checkSdk(node);
      },
      ArrayExpression(node) {
        const strings = elementStrings(context, node);

        if (!isFork(strings)) {
          return;
        }

        if (!strings.includes("--tools")) {
          report(node, "forks a session with no `--tools`, so the Judge has every tool");
        }

        checkForkElements(node);
      },
      ObjectExpression(node) {
        const judgeAt = node.properties.findIndex((part) => part.type === "Property" && keyOf(context, part) === JUDGE);

        if (judgeAt === -1) {
          return;
        }

        for (const [index, part] of node.properties.entries()) {
          if (index > judgeAt && (part.type === "SpreadElement" || runTimeKey(context, part))) {
            report(part, "spreads or computes a key after a Judge's `judgeSettings`, which could override it");
          }

          if (part.type !== "Property") {
            continue;
          }

          const key = keyOf(context, part);

          if (key === JUDGE && !isActorImport(context, part.value)) {
            report(part, "passes a Judge's settings that are not a constant imported from an actor file");
          } else if (key === "model" && constantString(context, part.value) !== null) {
            report(part, "writes a Judge's model as a string, where its actor file or its Review depth names it");
          }
        }
      },
    };
  },
});
