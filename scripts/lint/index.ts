import { definePlugin } from "@oxlint/plugins";

import { judgesRule } from "./judges.ts";
import { layersRule } from "./layers.ts";

export default definePlugin({
  meta: { name: "local" },
  rules: { layers: layersRule, judges: judgesRule },
});
