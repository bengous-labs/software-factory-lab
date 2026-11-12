import { posix } from "node:path";

import type { Context, Definition, ESTree, Reference, SourceCode } from "@oxlint/plugins";
import { defineRule } from "@oxlint/plugins";

import {
  DOMAIN_EFFECT_MODULES,
  EXTERNAL_IMPORTS,
  EXTERNALS,
  FILES,
  GLOBAL_LOADERS,
  GLOBAL_OBJECTS,
  IMPORT_META_PURE_MEMBERS,
  IO_GLOBALS,
  IO_LAYERS,
  IO_MEMBERS,
  LAYER_IMPORTS,
  LOADER_MEMBERS,
  OPEN_ZONE,
  PACKAGE_IMPORTS,
  PURE_MEMBERS,
  PURE_WITH_ARGUMENTS,
  TYPE_ONLY_IMPORTS,
  ZONE_CALLS,
  ZONES,
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

/** A zone of the factory: the directory, or the file, that names it, and its rank. */
export interface Zone {
  readonly name: string;
  readonly rank: number;
}

/** A zone's path matches a file it names, or any file under a directory it names. */
const ZONE_MATCHERS = ZONES.map(([path, rank]) => ({
  matcher: globToRegExp(path.endsWith(".ts") ? path : `${path}/**/*`),
  depth: path.split("/").length,
  rank,
}));

/** The zone of `path`, relative to the repository root; null for a file of no zone, such as one outside the factory. */
export function zoneOf(path: string): Zone | null {
  const found = ZONE_MATCHERS.find(({ matcher }) => matcher.test(path));

  // A zone is named by the path that holds the file, each `*` of the map read from it.
  return found === undefined ? null : { name: path.split("/").slice(0, found.depth).join("/"), rank: found.rank };
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

const ZONE_FIX =
  "Move what both need down to a zone both may import (`factory/land/shared/`, `factory/contract.ts`, `factory/lib/`), or have the door in `factory/bin/` pass it.";

/**
 * Why the zones refuse `importer`, placed at `from`, an import of `target`; null when they allow it. A test
 * imports any zone, a file outside the factory only the open one, and a file of the factory its own zone
 * and those of a lower rank.
 */
function zoneRefusal(importer: string, from: Place, target: string): string | null {
  const to = zoneOf(target);

  if (from.layer === "test" || to === null) {
    return null;
  }

  const own = zoneOf(importer);

  if (own === null) {
    return to.name === OPEN_ZONE
      ? null
      : `\`${importer}\` imports \`${target}\` (zone \`${to.name}\`): a file outside the factory imports only \`${OPEN_ZONE}/\`. ${OWNER}`;
  }

  const called = ZONE_CALLS.some(([caller, callee]) => caller === own.name && callee === to.name);

  return own.name === to.name || to.rank < own.rank || called
    ? null
    : `\`${importer}\` (zone \`${own.name}\`) imports \`${target}\` (zone \`${to.name}\`): a zone imports only itself and the zones below it. ${ZONE_FIX} ${OWNER}`;
}

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

  return reachable ? zoneRefusal(importer, from, target) : refusal(importer, from, target, labelOf(to, from));
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

const unzonedMessage = (path: string): string =>
  `\`${path}\` is in no zone of \`scripts/lint/layers.map.ts\`. Put the file in a directory of \`factory/\` the map names: a step of \`factory/land/\`, \`factory/land/shared/\`, \`factory/lib/\`. ${OWNER}`;

const unplacedWorkerMessage = (path: string): string =>
  `\`${path}\` starts a \`Worker\` the layer map cannot place. Start it as \`new Worker(new URL("./x.ts", import.meta.url))\`, with no options: a \`preload\` loads modules the map never places. ${OWNER}`;

const uncalledLoaderMessage = (path: string, loader: string): string =>
  `\`${path}\` reads \`${loader}\` without calling it, so the layer map cannot place what it loads. Call it with a string literal. ${OWNER}`;

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

  // `export {} from` names nothing, yet loads its module, as a side-effect import does.
  const kind: ImportKind =
    node.exportKind === "type" || (node.specifiers.length > 0 && values.length === 0) ? "type" : "value";

  return {
    specifier: source.value,
    kind,
    valueNames:
      values.length === 0 && kind === "value"
        ? ["*"]
        : values.map((part) => (part.local.type === "Literal" ? part.local.value : part.local.name)),
  };
}

/** Whether a definition is ambient, `declare const process: …`: it names a value something else creates, a global. */
const isAmbient = ({ node, parent }: Definition): boolean =>
  [node, parent].some((declared) => declared !== null && "declare" in declared && declared.declare);

/** Every reference of the file to a global: one no binding of the file declares, or one only an ambient declaration does. */
function globalReferences(sourceCode: SourceCode, program: ESTree.Program): Reference[] {
  const scope = sourceCode.getScope(program);

  const declared = sourceCode.scopeManager.scopes
    .flatMap((each) => each.variables)
    .filter((variable) => variable.defs.length > 0 && variable.defs.every((definition) => isAmbient(definition)));

  return [
    ...scope.through,
    ...[...scope.variables.filter((variable) => variable.defs.length === 0), ...declared].flatMap(
      (variable) => variable.references,
    ),
  ];
}

type Read = Reference["identifier"] | ESTree.MetaProperty;

/** The member `node` reads, by name; null when it is read whole or by a computed key. */
function memberOf(node: Read): string | null {
  const { parent } = node;

  return parent.type === "MemberExpression" && parent.object === node && !parent.computed ? parent.property.name : null;
}

/** Whether `identifier` is read in a type, which loads no code and reaches nothing. */
const inType = ({ parent }: Reference["identifier"]): boolean =>
  parent.type === "TSQualifiedName" || parent.type === "TSTypeQuery" || parent.type === "TSTypeReference";

/** Whether `identifier` is constructed with a first argument written out: a spread one may hold none. */
const constructedWithArguments = (identifier: Reference["identifier"]): boolean =>
  identifier.parent.type === "NewExpression" &&
  identifier.parent.callee === identifier &&
  identifier.parent.arguments[0] !== undefined &&
  identifier.parent.arguments[0].type !== "SpreadElement";

/**
 * The I/O global `identifier` reaches, or null. A global of `PURE_MEMBERS` read whole is refused, as it
 * can reach any member, and so is a global object, whatever follows it.
 */
function ioGlobalOf(identifier: Reference["identifier"]): string | null {
  if (inType(identifier)) {
    return null;
  }

  if (IO_GLOBALS.includes(identifier.name) || GLOBAL_OBJECTS.includes(identifier.name)) {
    return identifier.name;
  }

  const pure = PURE_MEMBERS.get(identifier.name);

  if (pure === undefined || (PURE_WITH_ARGUMENTS.includes(identifier.name) && constructedWithArguments(identifier))) {
    return null;
  }

  const member = memberOf(identifier);

  return member !== null && pure.includes(member) ? null : `${identifier.name}${member === null ? "" : `.${member}`}`;
}

/** The I/O `import.meta` reaches, or null. Its `require` loads a module, which the rule places as a loader. */
function ioMetaOf(node: ESTree.MetaProperty): string | null {
  const member = memberOf(node);

  if (
    node.meta.name !== "import" ||
    member === "require" ||
    (member !== null && IMPORT_META_PURE_MEMBERS.includes(member))
  ) {
    return null;
  }

  return `import.meta${member === null ? "" : `.${member}`}`;
}

/** The name of the member `node` reads, written or as a string literal key; null for any other computed key. */
function propertyNameOf(node: ESTree.MemberExpression): string | null {
  if (!node.computed) {
    return node.property.name;
  }

  return stringLiteralOf(node.property);
}

/** The name a destructuring takes, written or as a string literal key; null for any other computed key. */
function keyNameOf({ computed, key }: Pick<ESTree.BindingProperty, "computed" | "key">): string | null {
  if (!computed && key.type === "Identifier") {
    return key.name;
  }

  return key.type === "Literal" ? stringLiteralOf(key) : null;
}

/** Whether `node` holds the globals: `import.meta`, `globalThis`, `self`, `global` or `window`. */
const holdsGlobals = (node: ESTree.Node | null): boolean =>
  node !== null &&
  ((node.type === "MetaProperty" && node.meta.name === "import") ||
    (node.type === "Identifier" && GLOBAL_OBJECTS.includes(node.name)));

/** Whether reading `key` off `object` reaches a loader; `object` is null when the rule cannot see it. */
const isLoaderMember = (key: string, object: ESTree.Node | null): boolean =>
  LOADER_MEMBERS.includes(key) || (GLOBAL_LOADERS.includes(key) && holdsGlobals(object));

/** What a destructuring reads its keys from, when it is written `const { … } = object`; null otherwise. */
function destructuredOf(pattern: ESTree.Node): ESTree.Node | null {
  const declarator = pattern.parent;

  return declarator !== null && declarator.type === "VariableDeclarator" && declarator.id === pattern
    ? declarator.init
    : null;
}

const isImportMetaUrl = (node: ESTree.Node | undefined): boolean =>
  node?.type === "MemberExpression" &&
  !node.computed &&
  node.property.name === "url" &&
  node.object.type === "MetaProperty" &&
  node.object.meta.name === "import";

/** A read of a global by its name, or through a member of any object: `Worker`, `globalThis.Worker`. */
type GlobalRead = Reference["identifier"] | ESTree.MemberExpression;

/**
 * The module `new Worker(new URL("…", import.meta.url))` starts, as written: the one way to start a worker
 * whose module the map can place. Null for any other use of `Worker`, options included.
 */
function workerSpecifierOf(worker: GlobalRead): string | null {
  const started = worker.parent;

  if (started.type !== "NewExpression" || started.callee !== worker || started.arguments.length !== 1) {
    return null;
  }

  const [url] = started.arguments;

  if (url?.type !== "NewExpression" || url.callee.type !== "Identifier" || url.callee.name !== "URL") {
    return null;
  }

  const [specifier, base] = url.arguments;

  return specifier === undefined || specifier.type === "SpreadElement" || !isImportMetaUrl(base)
    ? null
    : stringLiteralOf(specifier);
}

/** The text of a string literal written with quotes; null for any other expression. */
function stringLiteralOf(node: ESTree.Expression): string | null {
  return node.type === "Literal" && /^["']/u.test(node.raw ?? "") ? String(node.value) : null;
}

const slashed = (path: string): string => path.replaceAll("\\", "/");

const REPO_ROOT = posix.join(slashed(import.meta.dirname), "..", "..");

/** The path from the repository root, whatever directory oxlint runs from; a file outside it reads from that directory. */
function relativePath(context: Context): string {
  const fromRoot = posix.relative(REPO_ROOT, slashed(context.filename));

  return fromRoot.startsWith("../") ? posix.relative(slashed(context.cwd), slashed(context.filename)) : fromRoot;
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

    // Every source file of the factory lies in a zone: one that lies in none could import, and be imported by, any.
    const unzoned = from.package === "factory" && from.layer !== "test" && zoneOf(path) === null;
    const io = IO_LAYERS.includes(from.layer);

    const reportIo = (node: ESTree.Node, global: string | null): void => {
      if (!io && global !== null) {
        context.report({ node, message: ioGlobalMessage(path, from, global) });
      }
    };

    const check = (node: ESTree.Node, edge: Edge): void => {
      const message = edgeRefusal(path, from, edge);

      if (message !== null) {
        context.report({ node, message });
      }
    };

    /** A module loaded at run time, by `import()` or a `require`: only a string literal can be placed. */
    const checkLoaded = (node: ESTree.Node, source: ESTree.Expression | null): void => {
      const specifier = source === null ? null : stringLiteralOf(source);

      if (specifier === null) {
        context.report({
          node,
          message: `\`${path}\` loads a computed specifier, which the layer map cannot place. Load a string literal. ${OWNER}`,
        });
      } else {
        check(node, { specifier, kind: "value", valueNames: ["*"] });
      }
    };

    /** A worker loads its module as `import()` does: only one started from a string literal can be placed. */
    const checkWorker = (worker: GlobalRead): void => {
      const specifier = workerSpecifierOf(worker);

      if (specifier === null) {
        context.report({ node: worker, message: unplacedWorkerMessage(path) });
      } else {
        check(worker.parent, { specifier, kind: "value", valueNames: ["*"] });
      }
    };

    /** A loader is placed where it is called; one read and not called could load anything, later. */
    const checkLoader = (loader: GlobalRead, name: string): void => {
      const call = loader.parent;

      if (call.type === "CallExpression" && call.callee === loader) {
        const [loaded] = call.arguments;

        checkLoaded(call, loaded === undefined || loaded.type === "SpreadElement" ? null : loaded);
      } else {
        context.report({ node: loader, message: uncalledLoaderMessage(path, name) });
      }
    };

    return {
      Program(node) {
        if (unzoned) {
          context.report({ node, message: unzonedMessage(path) });
        }

        for (const { identifier } of globalReferences(context.sourceCode, node)) {
          if (identifier.name === "Worker" && !inType(identifier)) {
            checkWorker(identifier);
          } else if (identifier.name === "require" && !inType(identifier)) {
            checkLoader(identifier, "require");
          } else {
            reportIo(identifier, ioGlobalOf(identifier));
          }
        }
      },
      MetaProperty(node) {
        reportIo(node, ioMetaOf(node));
      },
      MemberExpression(node) {
        const member = propertyNameOf(node);

        if (member === null) {
          return;
        }

        if (member === "Worker" && holdsGlobals(node.object)) {
          checkWorker(node);
        } else if (isLoaderMember(member, node.object)) {
          checkLoader(node, `.${member}`);
        }

        reportIo(node.property, IO_MEMBERS.includes(member) ? `.${member}` : null);
      },
      Property(node) {
        const key = node.parent.type === "ObjectPattern" ? keyNameOf(node) : null;

        // A loader taken by a destructuring is read, never called where the rule can place it.
        if (key !== null && isLoaderMember(key, destructuredOf(node.parent))) {
          context.report({ node, message: uncalledLoaderMessage(path, key) });
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
        checkLoaded(node, node.source);
      },
      TSImportEqualsDeclaration(node) {
        if (node.moduleReference.type === "TSExternalModuleReference") {
          check(node, {
            specifier: node.moduleReference.expression.value,
            kind: node.importKind === "type" ? "type" : "value",
            valueNames: ["*"],
          });
        }
      },
      TSImportType(node) {
        check(node, { specifier: node.source.value, kind: "type", valueNames: [] });
      },
    };
  },
});
