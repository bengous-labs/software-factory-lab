import { posix } from "node:path";

import type { Context, ESTree, Reference, SourceCode } from "@oxlint/plugins";
import { defineRule } from "@oxlint/plugins";

import {
  BUN_IO_MEMBERS,
  DOMAIN_EFFECT_MODULES,
  EXTERNAL_IMPORTS,
  EXTERNALS,
  FILES,
  IO_GLOBALS,
  IO_LAYERS,
  LAYER_IMPORTS,
  PACKAGE_IMPORTS,
  TYPE_ONLY_IMPORTS,
} from "./layers.map.ts";
import type { External, Place } from "./layers.map.ts";

const OWNER = "Do not change the map or the rule: they belong to the Owner.";

const FIX =
  "Fix the import: the entry point does the I/O and passes the result; depend on the port, not the live layer; use `import type` when a type is enough.";

/** A single star stays inside one path segment; a double star and its slash span any number of segments, none included. */
export function globToRegExp(glob: string): RegExp {
  const source = glob
    .split(/(\*\*\/|\*)/u)
    .map((part) => {
      if (part === "**/") {
        return "(?:.*/)?";
      }

      if (part === "*") {
        return "[^/]*";
      }

      return part.replaceAll(/[.+?^${}()|[\]\\]/gu, String.raw`\$&`);
    })
    .join("");

  return new RegExp(`^${source}$`, "u");
}

const MATCHERS = FILES.map(([glob, place]) => [globToRegExp(glob), place] as const);

/** The place the map gives `path`, relative to the repository root; null when no glob matches it. */
export function placeOf(path: string): Place | null {
  return MATCHERS.find(([matcher]) => matcher.test(path))?.[1] ?? null;
}

function externalOf(specifier: string): External | null {
  const found = EXTERNALS.find(([name]) =>
    name.endsWith("/") || name.endsWith(":") ? specifier.startsWith(name) : specifier === name,
  );

  return found?.[1] ?? null;
}

/** The file a relative specifier names, from the root; null for a bare specifier or one that leaves the root. */
export function resolvedPath(importer: string, specifier: string): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return null;
  }

  const path = posix.normalize(posix.join(posix.dirname(importer), specifier));

  return path.startsWith("../") ? null : path;
}

type ImportKind = "type" | "value";

/** One import edge: what it names, and the names it takes, `*` for a whole module or a side effect. */
export interface Edge {
  readonly specifier: string;
  readonly kind: ImportKind;
  readonly valueNames: readonly string[];
}

const labelOf = (place: Place, from: Place): string =>
  place.package === from.package ? place.layer : `${place.package} ${place.layer}`;

const refusal = (importer: string, from: Place, target: string, label: string): string =>
  `\`${importer}\` (${labelOf(from, from)}) imports \`${target}\` (${label}). ${FIX} ${OWNER}`;

function externalRefusal(importer: string, from: Place, edge: Edge, external: External): string | null {
  if (!EXTERNAL_IMPORTS[from.layer].includes(external)) {
    return refusal(importer, from, edge.specifier, external);
  }

  if (from.layer !== "domain" || external !== "effect" || edge.kind === "type") {
    return null;
  }

  const module = edge.specifier === "effect" ? null : edge.specifier.slice("effect/".length);
  const names = module === null ? edge.valueNames : [module];
  const refused = names.filter((name) => !DOMAIN_EFFECT_MODULES.includes(name));

  return refused.length === 0
    ? null
    : refusal(
        importer,
        from,
        edge.specifier,
        `effect ${refused.join(", ")}; the domain takes only ${DOMAIN_EFFECT_MODULES.join(", ")}`,
      );
}

function localRefusal(importer: string, from: Place, target: string, kind: ImportKind): string | null {
  const to = placeOf(target);

  if (to === null) {
    return `\`${importer}\` imports \`${target}\`, which no layer of the map holds. Import a module the map allows to its layer. ${OWNER}`;
  }

  const reachable =
    PACKAGE_IMPORTS[from.package].includes(to.package) &&
    (LAYER_IMPORTS[from.layer].includes(to.layer) || (kind === "type" && TYPE_ONLY_IMPORTS.includes(to.layer)));

  return reachable ? null : refusal(importer, from, target, labelOf(to, from));
}

/** Why the map refuses `edge` out of `importer`, placed at `from`; null when it allows it. */
export function edgeRefusal(importer: string, from: Place, edge: Edge): string | null {
  const external = externalOf(edge.specifier);

  if (external !== null) {
    return externalRefusal(importer, from, edge, external);
  }

  const target = resolvedPath(importer, edge.specifier);

  if (target === null) {
    return `\`${importer}\` imports \`${edge.specifier}\`, a specifier the layer map does not know. Import a module the map allows to its layer. ${OWNER}`;
  }

  return localRefusal(importer, from, target, edge.kind);
}

const unplacedMessage = (path: string): string =>
  `\`${path}\` is in no layer of \`scripts/lint/layers.map.ts\`. Put the file in a directory the map classifies. ${OWNER}`;

const ioGlobalMessage = (path: string, from: Place, global: string): string =>
  `\`${path}\` (${from.layer}) uses \`${global}\`, I/O that only ${IO_LAYERS.join(", ")} may do. The entry point does the I/O and passes the result, or the code goes behind a port. ${OWNER}`;

type ImportSpecifierNode = ESTree.ImportDeclaration["specifiers"][number];

function importEdge(node: ESTree.ImportDeclaration): Edge {
  const values = node.importKind === "type" ? [] : node.specifiers.filter((part) => !isTypeSpecifier(part));

  const kind: ImportKind =
    node.importKind === "type" || (node.specifiers.length > 0 && values.length === 0) ? "type" : "value";

  return {
    specifier: node.source.value,
    kind,
    valueNames: values.length === 0 && kind === "value" ? ["*"] : values.map((part) => importedName(part)),
  };
}

const isTypeSpecifier = (part: ImportSpecifierNode): boolean =>
  part.type === "ImportSpecifier" && part.importKind === "type";

function importedName(part: ImportSpecifierNode): string {
  if (part.type !== "ImportSpecifier") {
    return "*";
  }

  return part.imported.type === "Literal" ? part.imported.value : part.imported.name;
}

function exportEdge(node: ESTree.ExportNamedDeclaration, source: ESTree.StringLiteral): Edge {
  const values = node.exportKind === "type" ? [] : node.specifiers.filter((part) => part.exportKind !== "type");
  const kind: ImportKind = node.exportKind === "type" || values.length === 0 ? "type" : "value";

  return {
    specifier: source.value,
    kind,
    valueNames: values.map((part) => (part.local.type === "Literal" ? part.local.value : part.local.name)),
  };
}

/** Every reference of the file to a global: one no binding of the file declares. */
function globalReferences(sourceCode: SourceCode, program: ESTree.Program): Reference[] {
  const scope = sourceCode.getScope(program);

  return [
    ...scope.through,
    ...scope.variables.filter((variable) => variable.defs.length === 0).flatMap((variable) => variable.references),
  ];
}

/** The I/O global `identifier` reaches, or null: `Bun` read whole is refused, as it can reach any member. */
function ioGlobalOf(identifier: Reference["identifier"]): string | null {
  if (IO_GLOBALS.includes(identifier.name)) {
    return identifier.name;
  }

  if (identifier.name !== "Bun") {
    return null;
  }

  const { parent } = identifier;

  if (parent.type !== "MemberExpression" || parent.object !== identifier || parent.computed) {
    return "Bun";
  }

  return BUN_IO_MEMBERS.includes(parent.property.name) ? `Bun.${parent.property.name}` : null;
}

/** The text of a string literal written with quotes; null for any other expression. */
function stringLiteralOf(node: ESTree.Expression): string | null {
  return node.type === "Literal" && /^["']/u.test(node.raw ?? "") ? String(node.value) : null;
}

function relativePath(context: Context): string {
  return posix.relative(context.cwd.replaceAll("\\", "/"), context.filename.replaceAll("\\", "/"));
}

export const layersRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Keep each file to what its layer in `scripts/lint/layers.map.ts` may import and do." },
  },
  create(context) {
    const path = relativePath(context);
    const from = placeOf(path);

    if (from === null) {
      return {
        Program(node) {
          context.report({ node, message: unplacedMessage(path) });
        },
      };
    }

    const check = (node: ESTree.Node, edge: Edge): void => {
      const message = edgeRefusal(path, from, edge);

      if (message !== null) {
        context.report({ node, message });
      }
    };

    return {
      Program(node) {
        if (IO_LAYERS.includes(from.layer)) {
          return;
        }

        for (const reference of globalReferences(context.sourceCode, node)) {
          const global = ioGlobalOf(reference.identifier);

          if (global !== null) {
            context.report({ node: reference.identifier, message: ioGlobalMessage(path, from, global) });
          }
        }
      },
      ImportDeclaration(node) {
        check(node, importEdge(node));
      },
      ExportNamedDeclaration(node) {
        if (node.source !== null) {
          check(node, exportEdge(node, node.source));
        }
      },
      ExportAllDeclaration(node) {
        check(node, {
          specifier: node.source.value,
          kind: node.exportKind === "type" ? "type" : "value",
          valueNames: ["*"],
        });
      },
      ImportExpression(node) {
        const specifier = stringLiteralOf(node.source);

        if (specifier === null) {
          context.report({
            node,
            message: `\`${path}\` imports a computed specifier, which the layer map cannot place. Import a string literal. ${OWNER}`,
          });
        } else {
          check(node, { specifier, kind: "value", valueNames: ["*"] });
        }
      },
      TSImportType(node) {
        check(node, { specifier: node.source.value, kind: "type", valueNames: [] });
      },
    };
  },
});
