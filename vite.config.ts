import { defineConfig } from "vite-plus";

import { WORKLET_REALM_FILES } from "./packages/core/src/worklet-realm-files.ts";

// AudioWorkletGlobalScope (audio thread) に存在しない main-thread / Node の web API。
// worklet バンドルに同梱されるソース (= `WORKLET_REALM_FILES`) がこれらを参照すると、
// browser で worklet module load 時に即 throw し、その processor は一切鳴らせなくなる。
// node の unit test は Node がこれらを持つので素通りする = lint で構造的に落とす。
const WORKLET_FORBIDDEN_GLOBALS = [
  "TextEncoder",
  "TextDecoder",
  "TextEncoderStream",
  "TextDecoderStream",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "Request",
  "Response",
  "Headers",
  "FormData",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "setImmediate",
  "clearImmediate",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "requestIdleCallback",
  "cancelIdleCallback",
  "document",
  "window",
  "navigator",
  "location",
  "history",
  "alert",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "caches",
  "atob",
  "btoa",
  "Worker",
  "SharedWorker",
  "MessageChannel",
  "BroadcastChannel",
  "Blob",
  "File",
  "FileReader",
  "URL",
  "URLSearchParams",
  "AudioContext",
  "OfflineAudioContext",
  "crypto",
  "performance",
];

const workletRealmGlobalsRule = [
  "error",
  ...WORKLET_FORBIDDEN_GLOBALS.map((name) => ({
    name,
    message: `${name} is not available in AudioWorkletGlobalScope (audio thread). Keep worklet-realm code (reachable from worklet-entry.ts) free of main-thread / Node web APIs; move such code to a main-only module. See packages/core/src/worklet-realm-files.ts.`,
  })),
] as ["error", ...Array<{ name: string; message: string }>];

export default defineConfig({
  fmt: {},
  staged: {
    // pre-commit hook で staged file に vp check --fix を 自動 (= fmt + lint
    // auto-fix)。 test は 走 ら さ ない (= commit 単位 で 落 ち て いる の は OK、
    // format は 常 に 自 動)。 hooks の install は `vp config` で 1 度 だ け、
    // `.vite-hooks/` を repo に commit し て 他 dev clone で も 同 hook を 効
    // か せ る。
    "*.{js,jsx,ts,tsx,json,yaml,yml}": "vp check --fix",
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
    overrides: [
      {
        files: WORKLET_REALM_FILES.map((f) => `packages/core/${f}`),
        rules: {
          "no-restricted-globals": workletRealmGlobalsRule,
          // 相対 main-only モジュールの混入は `worklet-realm-files.test.ts` が graph で
          // 検出するが、bare module は graph トレース対象外。worklet バンドルへ入ると
          // 致命的な node-only dep を import 段階で禁止する。
          "no-restricted-imports": [
            "error",
            {
              paths: [
                {
                  name: "binaryen",
                  message:
                    "binaryen (WASM compiler) must never enter the worklet bundle — it pulls Node-only APIs. compile() runs at build time only, outside AudioWorkletGlobalScope.",
                },
              ],
            },
          ],
        },
      },
    ],
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
      "packages/core/vite.browser.config.ts",
      "packages/core/vite.browser-postmessage.config.ts",
    ],
    // `experiments/*` are intentionally NOT aggregated here: an experiment that
    // depends on `@vitejs/devtools` (devtools-proto) makes pnpm key a separate
    // copy of the vite-plus test runner by that peer, so its files would load a
    // different runner instance than this shared collector and throw "Vitest
    // failed to find the current suite". They run standalone in CI instead, where
    // each is its own root and there is a single runner instance.
    // root の default project は 何 も 拾 わ な い (= include 空)。 全 test は
    // sub project (= 上 の projects) 経 由 で 拾 う 形 に 統 一。
    include: [],
  },
});
