import { defineConfig } from "oxlint";

/**
 * `local/layers` alone. `bun run lint` lints the mods of `.claude/plugins/` with it: the main config leaves
 * them out, since their types come from Claude Code and no type-aware rule can read them. The rule's tests
 * run it too.
 */
export default defineConfig({
  categories: { correctness: "off" },
  jsPlugins: [{ name: "local", specifier: `${import.meta.dirname}/index.ts` }],
  rules: { "local/layers": "error" },
});
