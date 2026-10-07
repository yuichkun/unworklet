import { defineConfig } from "vite-plus";

import coreConfig from "./vite.config.ts";

export default defineConfig({
  ...coreConfig,
  test: {
    ...coreConfig.test,
    // Keep a second uninstrumented fast-check sample in addition to coverage.
    name: "core-midi-property-resample",
    include: ["src/midiWire.property.test.ts"],
  },
});
