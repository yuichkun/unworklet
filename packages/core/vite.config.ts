import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    dts: true,
    exports: false,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Exclude types-only files + public re-export hubs + test files
      // (= `AGENTS.md` Testing policy 通 り).
      exclude: [
        "src/**/*.test.ts",
        // types-only (= no functions / branches)
        "src/types.ts",
        "src/compile/ast.ts",
        // public re-export hub (= `export` 文 だ け)
        "src/index.ts",
      ],
      reporter: ["text", "html", "json-summary"],
      thresholds: {
        branches: 98,
      },
    },
  },
});
