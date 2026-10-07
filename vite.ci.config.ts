import { defineConfig } from "vite-plus";

import rootConfig from "./vite.config.ts";

export default defineConfig({
  ...rootConfig,
  test: {
    ...rootConfig.test,
    // Package coverage jobs own Node assertions; these realms have separate oracles.
    projects: [
      "packages/core/vite.browser.config.ts",
      "packages/core/vite.browser-postmessage.config.ts",
      "packages/unplugin/vite.integration.config.ts",
      "scripts/vite.config.ts",
      // DevTools coverage is not a required branch-protection check.
      "packages/unplugin/devtools-ui/vite.config.ts",
      "packages/core/vite.midi-property.config.ts",
    ],
  },
});
