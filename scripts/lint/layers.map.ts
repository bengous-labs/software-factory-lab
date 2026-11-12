/**
 * The layer of every linted file, what each layer may import, and the zones of the factory. `local/layers`
 * reads it; the Owner owns it. Under `factory/` a file's layer is read in its name and its zone in its
 * directory, so a file added there needs no entry here.
 */

export type Package = "app" | "factory" | "tooling" | "mods";

export type Layer = "domain" | "ports" | "infra" | "entry" | "tooling" | "test";

export interface Place {
  readonly package: Package;
  readonly layer: Layer;
}

const at = (pkg: Package, layer: Layer): Place => ({ package: pkg, layer });

/** Paths from the repository root. The first glob that matches wins, so a file comes before a glob that also matches it. */
export const FILES: ReadonlyArray<readonly [glob: string, place: Place]> = [
  // The factory: a suffix says the layer, and so does the directory of a process's door. A name with no
  // suffix is logic: it does no I/O itself, and reaches outside only through a port it is handed.
  ["factory/**/*.test.ts", at("factory", "test")],
  ["factory/**/*.fixtures.ts", at("factory", "test")],
  ["factory/bin/*.ts", at("factory", "entry")],
  ["factory/hooks/*.ts", at("factory", "entry")],
  ["factory/**/*.live.ts", at("factory", "infra")],
  ["factory/**/*.port.ts", at("factory", "ports")],
  ["factory/**/*.ts", at("factory", "domain")],

  ["app/test/**/*.test.ts", at("app", "test")],
  ["scripts/*/**/*.test.ts", at("tooling", "test")],

  ["app/src/task.ts", at("app", "domain")],
  ["app/src/commands/*.ts", at("app", "domain")],
  ["app/src/store/*.ts", at("app", "infra")],
  ["app/src/cli.ts", at("app", "entry")],

  ["scripts/hooks/*.ts", at("tooling", "entry")],
  ["scripts/gates/*.ts", at("tooling", "tooling")],
  ["scripts/lint/*.ts", at("tooling", "tooling")],
  ["scripts/ci/fast-check-seed.ts", at("tooling", "test")],
  ["scripts/ci/*.ts", at("tooling", "tooling")],
  ["scripts/lab/*.ts", at("tooling", "tooling")],
  ["*.config.ts", at("tooling", "tooling")],

  // The mods: Claude Code loads each hook module, and its tests run under `claude plugin test`.
  [".claude/plugins/**/*.test.tsx", at("mods", "test")],
  [".claude/plugins/**/*.tsx", at("mods", "entry")],
];

/** The packages a package may import from, itself included. The factory imports nothing outside `factory/`. */
export const PACKAGE_IMPORTS: Readonly<Record<Package, readonly Package[]>> = {
  app: ["app"],
  factory: ["factory"],
  tooling: ["tooling", "factory"],
  mods: ["mods", "factory"],
};

const ALL_LAYERS: readonly Layer[] = ["domain", "ports", "infra", "entry", "tooling", "test"];

/** The layers a layer may import from, inside the packages it may import from. */
export const LAYER_IMPORTS: Readonly<Record<Layer, readonly Layer[]>> = {
  domain: ["domain", "ports"],
  ports: ["domain", "ports"],
  infra: ["domain", "ports", "infra"],
  entry: ["domain", "ports", "infra", "tooling"],
  tooling: ["domain", "tooling"],
  test: ALL_LAYERS,
};

/** What a type-only import may reach besides `LAYER_IMPORTS`: types of the pure layers load no code. */
export const TYPE_ONLY_IMPORTS: readonly Layer[] = ["domain", "ports"];

/**
 * The zones of `factory/`, each a directory, or a file, with its rank. A file imports its own zone and the
 * zones of a lower rank, never another zone of its rank nor one above: a door calls everything and nothing
 * calls a door, Dispatch, the watch and the measure read the Land loop, and a step of the Land loop takes
 * from what the steps share. A `*` stands for one directory name: each directory of `factory/land/` but
 * `shared` is a step, and a zone of its own. The first zone that holds a file wins. A test imports any zone.
 */
export const ZONES: ReadonlyArray<readonly [path: string, rank: number]> = [
  ["factory/bin", 5],
  ["factory/hooks", 5],
  ["factory/dispatch", 4],
  ["factory/watch", 4],
  ["factory/measure", 4],
  ["factory/land/shared", 2],
  ["factory/land/*", 3],
  ["factory/install", 1],
  ["factory/contract.ts", 1],
  ["factory/lib", 0],
];

/** The zones that call a zone of their own rank: the Merge bot calls the routing and the review. */
export const ZONE_CALLS: ReadonlyArray<readonly [from: string, to: string]> = [
  ["factory/land/merge-bot", "factory/land/routing"],
  ["factory/land/merge-bot", "factory/land/review"],
];

/** The one zone of the factory a file outside it may import. */
export const OPEN_ZONE = "factory/lib";

export type External =
  "effect" | "node" | "loader" | "bun" | "bun-test" | "agent-sdk" | "oxlint" | "stryker" | "fast-check" | "claude-code";

/**
 * Bare specifiers, by exact name or by prefix ending in `/` or `:`. A bare specifier no entry names is an
 * error. The first entry that names a specifier wins.
 */
export const EXTERNALS: ReadonlyArray<readonly [specifier: string, external: External]> = [
  ["effect", "effect"],
  ["effect/", "effect"],
  // `createRequire` and a worker thread load a module from a path at run time, where the map cannot place it.
  ["node:module", "loader"],
  ["node:worker_threads", "loader"],
  ["node:", "node"],
  ["bun", "bun"],
  ["bun:test", "bun-test"],
  ["@anthropic-ai/claude-agent-sdk", "agent-sdk"],
  ["oxlint", "oxlint"],
  ["@oxlint/plugins", "oxlint"],
  ["@stryker-mutator/core", "stryker"],
  ["fast-check", "fast-check"],
  ["claude-code", "claude-code"],
  ["claude-code/", "claude-code"],
];

/** The bare specifiers each layer may import. No layer imports a `loader`. */
export const EXTERNAL_IMPORTS: Readonly<Record<Layer, readonly External[]>> = {
  domain: ["effect"],
  ports: ["effect"],
  infra: ["effect", "node", "bun", "agent-sdk"],
  entry: ["effect", "node", "bun", "agent-sdk", "claude-code"],
  tooling: ["effect", "node", "bun", "oxlint", "stryker"],
  test: ["effect", "node", "bun", "bun-test", "agent-sdk", "oxlint", "fast-check", "claude-code"],
};

/**
 * The only `effect` modules the domain may import as values, its data toolbox: schemas and what builds
 * them, plain result values and type guards. `Exit.succeed` gives a schema its decoding default. The
 * runtime, `Effect` itself among it, stays in the infra and the entry points; a type-only import may name
 * any module.
 */
export const DOMAIN_EFFECT_MODULES: readonly string[] = [
  "Schema",
  "SchemaGetter",
  "SchemaTransformation",
  "Data",
  "Option",
  "Result",
  "Exit",
  "Struct",
  "Predicate",
];

/**
 * The globals that reach outside the process (the network, the environment, the terminal), read the clock
 * (`Intl` formats the current date by default), or run code from a string, which reaches any of them.
 */
export const IO_GLOBALS: readonly string[] = [
  "fetch",
  "WebSocket",
  "process",
  "navigator",
  "console",
  "prompt",
  "alert",
  "confirm",
  "eval",
  "Function",
  "Intl",
  "crypto",
  "performance",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "clearTimeout",
  "clearInterval",
  "clearImmediate",
];

/**
 * The globals every layer may use through these members alone; read whole or through any other member,
 * each is I/O: `Bun.spawn`, `Bun.file`, `Bun.env`, `Date.now`, ….
 */
export const PURE_MEMBERS: ReadonlyMap<string, readonly string[]> = new Map([
  ["Bun", ["Glob"]],
  ["Date", ["parse", "UTC"]],
]);

/** The globals every layer may construct with arguments: `new Date()` alone reads the clock. */
export const PURE_WITH_ARGUMENTS: readonly string[] = ["Date"];

/**
 * The members that load a module on any object: `process.getBuiltinModule`. The rule reads no types, so it
 * takes the name alone, and places what each loads where it is called. `require` and `Worker` load a module
 * too, as globals: read off `import.meta` or a global object, as `GLOBAL_LOADERS`.
 */
export const LOADER_MEMBERS: readonly string[] = ["getBuiltinModule"];

/** The globals that load a module, read by their name or off `import.meta` and the global objects. */
export const GLOBAL_LOADERS: readonly string[] = ["require", "Worker"];

/**
 * The members refused on any object outside the I/O layers, as the rule reads no types: those of a
 * `Bun.Glob` that read the disk, and `constructor`, which reaches the `Function` constructor from any
 * function.
 */
export const IO_MEMBERS: readonly string[] = ["scan", "scanSync", "constructor"];

/** The members of `import.meta` every layer may read: any other (`env`, `main`, `resolve`, …) is I/O. */
export const IMPORT_META_PURE_MEMBERS: readonly string[] = ["url"];

/** The global objects, refused whatever member follows: each reaches every global, the I/O ones included. */
export const GLOBAL_OBJECTS: readonly string[] = ["globalThis", "self", "global", "window"];

/** The layers that may use `IO_GLOBALS`, every member of `PURE_MEMBERS`' globals and of `import.meta`, and the global objects. */
export const IO_LAYERS: readonly Layer[] = ["infra", "entry", "tooling", "test"];
