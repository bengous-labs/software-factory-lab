/**
 * The layer of every linted file, and what each layer may import. `local/layers` reads it; the Owner
 * owns it.
 */

export type Package = "app" | "land-loop" | "factory" | "tooling" | "shared";

export type Layer = "domain" | "ports" | "application" | "infra" | "entry" | "tooling" | "test";

export interface Place {
  readonly package: Package;
  readonly layer: Layer;
}

const at = (pkg: Package, layer: Layer): Place => ({ package: pkg, layer });

/** Paths from the repository root. The first glob that matches wins, so a file comes before a glob that also matches it. */
export const FILES: ReadonlyArray<readonly [glob: string, place: Place]> = [
  ["app/test/**/*.test.ts", at("app", "test")],
  ["scripts/land-loop/**/*.test.ts", at("land-loop", "test")],
  ["scripts/factory/*.test.ts", at("factory", "test")],
  ["scripts/land-loop/arbitraries.ts", at("land-loop", "test")],
  ["scripts/lib/*.test.ts", at("shared", "test")],
  ["scripts/*/**/*.test.ts", at("tooling", "test")],

  ["app/src/task.ts", at("app", "domain")],
  ["app/src/commands/*.ts", at("app", "domain")],
  ["app/src/store/*.ts", at("app", "infra")],
  ["app/src/cli.ts", at("app", "entry")],

  ["scripts/land-loop/merge-bot/main.ts", at("land-loop", "entry")],
  ["scripts/land-loop/stop/hook.ts", at("land-loop", "entry")],
  ["scripts/land-loop/stop/fork-guard.ts", at("land-loop", "entry")],
  ["scripts/land-loop/relay/main.ts", at("land-loop", "entry")],
  ["scripts/land-loop/queue/repost.ts", at("land-loop", "entry")],
  ["scripts/land-loop/review/run-review.ts", at("land-loop", "entry")],
  ["scripts/land-loop/review/read-threads.ts", at("land-loop", "entry")],
  ["scripts/land-loop/measure/main.ts", at("land-loop", "entry")],
  ["scripts/land-loop/*/decide.ts", at("land-loop", "domain")],
  ["scripts/land-loop/routing/routing-rules.ts", at("land-loop", "domain")],
  ["scripts/land-loop/factory-config.ts", at("land-loop", "domain")],
  ["scripts/land-loop/author-mark.ts", at("land-loop", "domain")],
  ["scripts/land-loop/logins.ts", at("land-loop", "domain")],
  ["scripts/land-loop/stop/done-prompt.ts", at("land-loop", "domain")],
  ["scripts/land-loop/ports/*.ts", at("land-loop", "ports")],
  ["scripts/land-loop/review/*.ts", at("land-loop", "application")],
  ["scripts/land-loop/routing/routing-judge.ts", at("land-loop", "application")],
  ["scripts/land-loop/routing/routing-prompt.ts", at("land-loop", "application")],
  ["scripts/land-loop/relay/wakes.ts", at("land-loop", "application")],
  ["scripts/land-loop/lib/*.ts", at("land-loop", "infra")],

  ["scripts/factory/dispatch.ts", at("factory", "entry")],
  ["scripts/factory/dispatch-plan.ts", at("factory", "domain")],
  ["scripts/factory/dispatcher.ts", at("factory", "application")],
  ["scripts/factory/watch.ts", at("factory", "entry")],
  ["scripts/factory/watch-plan.ts", at("factory", "domain")],
  ["scripts/factory/watcher.ts", at("factory", "application")],

  // Pure helpers both the Land loop and the tooling import.
  ["scripts/lib/*.ts", at("shared", "domain")],

  ["scripts/hooks/*.ts", at("tooling", "entry")],
  ["scripts/gates/*.ts", at("tooling", "tooling")],
  ["scripts/lint/*.ts", at("tooling", "tooling")],
  ["scripts/ci/fast-check-seed.ts", at("tooling", "test")],
  ["scripts/ci/*.ts", at("tooling", "tooling")],
  ["scripts/lab/*.ts", at("tooling", "tooling")],
  ["*.config.ts", at("tooling", "tooling")],
];

/** The packages a package may import from, itself included. */
export const PACKAGE_IMPORTS: Readonly<Record<Package, readonly Package[]>> = {
  app: ["app"],
  "land-loop": ["land-loop", "shared"],
  factory: ["factory", "land-loop", "shared"],
  tooling: ["tooling", "shared"],
  shared: ["shared"],
};

const ALL_LAYERS: readonly Layer[] = ["domain", "ports", "application", "infra", "entry", "tooling", "test"];

/** The layers a layer may import from, inside the packages it may import from. */
export const LAYER_IMPORTS: Readonly<Record<Layer, readonly Layer[]>> = {
  domain: ["domain"],
  ports: ["domain", "ports"],
  application: ["domain", "ports", "application"],
  infra: ["domain", "ports", "infra"],
  entry: ["domain", "ports", "application", "infra", "tooling"],
  tooling: ["domain", "tooling"],
  test: ALL_LAYERS,
};

/** What a type-only import may reach besides `LAYER_IMPORTS`: types of the pure layers load no code. */
export const TYPE_ONLY_IMPORTS: readonly Layer[] = ["domain", "ports", "application"];

export type External = "effect" | "node" | "bun" | "bun-test" | "agent-sdk" | "oxlint" | "stryker" | "fast-check";

/** Bare specifiers, by exact name or by prefix ending in `/` or `:`. A bare specifier no entry names is an error. */
export const EXTERNALS: ReadonlyArray<readonly [specifier: string, external: External]> = [
  ["effect", "effect"],
  ["effect/", "effect"],
  ["node:", "node"],
  ["bun", "bun"],
  ["bun:test", "bun-test"],
  ["@anthropic-ai/claude-agent-sdk", "agent-sdk"],
  ["oxlint", "oxlint"],
  ["@oxlint/plugins", "oxlint"],
  ["@stryker-mutator/core", "stryker"],
  ["fast-check", "fast-check"],
];

/** The bare specifiers each layer may import. */
export const EXTERNAL_IMPORTS: Readonly<Record<Layer, readonly External[]>> = {
  domain: ["effect"],
  ports: ["effect"],
  application: ["effect"],
  infra: ["effect", "node", "bun", "agent-sdk"],
  entry: ["effect", "node", "bun", "agent-sdk"],
  tooling: ["effect", "node", "bun", "oxlint", "stryker"],
  test: ["effect", "node", "bun", "bun-test", "agent-sdk", "oxlint", "fast-check"],
};

/** The only `effect` modules the domain may import as values; a type-only import may name any. */
export const DOMAIN_EFFECT_MODULES: readonly string[] = ["Schema", "Data", "Option", "Result", "Struct"];

export const IO_GLOBALS: readonly string[] = ["fetch", "process"];

/** The members of `Bun` every layer may use; any other (`spawn`, `file`, `write`, `env`, `stdout`, …) is I/O. */
export const BUN_PURE_MEMBERS: readonly string[] = ["Glob"];

/** The global objects, refused whatever member follows: each reaches every global, the I/O ones included. */
export const GLOBAL_OBJECTS: readonly string[] = ["globalThis", "self", "global", "window"];

/** The layers that may use `IO_GLOBALS`, every member of `Bun` and the global objects. */
export const IO_LAYERS: readonly Layer[] = ["infra", "entry", "tooling", "test"];
