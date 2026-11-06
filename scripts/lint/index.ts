import { definePlugin } from "@oxlint/plugins";

import { layersRule } from "./layers.ts";

export default definePlugin({
  meta: { name: "local" },
  rules: { layers: layersRule },
});
