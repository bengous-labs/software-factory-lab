import { defineConfig } from "oxlint";

import { BUDGETS } from "./exceptions.ts";

/** The budget rules alone, with no exception: what `check-exception-ratchet.ts` lints the listed files with. */
export default defineConfig({
  categories: { correctness: "off" },
  jsPlugins: ["oxlint-plugin-complexity"],
  rules: BUDGETS,
});
