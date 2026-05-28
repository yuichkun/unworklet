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
    // Default `vp test` (= root から の monorepo 全 走 行) は Node-side
    // 限 定。 `*.browser.test.ts` は browser mode で だ け 拾 う = 各
    // package の `vite.config.ts` で 個 別 に enable + provider 設 定 +
    // playwright install す る 形 (= `docs/10-roadmap.md` §Phase 6 完
    // 了 条 件)。
    exclude: [
      "**/*.browser.test.ts",
      "**/__tests__/browser/**",
      "**/node_modules/**",
      "**/dist/**",
    ],
  },
});
