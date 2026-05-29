import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
  },
  test: {
    // `vp test` 1 発で node-side + browser e2e (SAB / postMessage) を 1 stage で
    // 集 約。 vitest 4 の `projects` 機 能 経 由 で 各 package の vite.config.ts
    // を default project、 packages/core の 2 browser config を 別 project と し
    // て 並 列 実 行。 playwright spec (= examples/01-stereo-gain/tests/) は別
    // runner = vitest 集 約 外、 root package.json の scripts.test で chain。
    projects: [
      "packages/*/vite.config.ts",
      "examples/*/vite.config.ts",
      "experiments/*/vite.config.ts",
      "packages/core/vite.browser.config.ts",
      "packages/core/vite.browser-postmessage.config.ts",
    ],
    // root の default project は 何 も 拾 わ な い (= include 空)。 全 test は
    // sub project (= 上 の projects) 経 由 で 拾 う 形 に 統 一。
    include: [],
  },
});
