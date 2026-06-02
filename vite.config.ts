import { defineConfig } from "vite-plus";

import { WORKLET_REALM_FILES } from "./packages/core/src/worklet-realm-files.ts";

// main-thread / Node web APIs that do not exist in AudioWorkletGlobalScope (audio thread).
// If source bundled into the worklet (i.e. `WORKLET_REALM_FILES`) references any of these,
// the browser throws immediately when loading the worklet module, and that processor can
// never produce sound. Node unit tests pass silently because Node provides these globals,
// so we catch the problem structurally with lint instead.
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
    // Run vp check --fix automatically on staged files in the pre-commit hook
    // (i.e. fmt + lint auto-fix). Tests are not run (failing tests within a
    // commit are OK; formatting is always applied automatically). Install the
    // hooks once with `vp config`, and commit `.vite-hooks/` to the repo so the
    // same hook is active for other devs who clone it.
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
          // `worklet-realm-files.test.ts` detects leaked relative main-only modules
          // via the graph, but bare modules are outside graph tracing. Forbid, at
          // the import level, node-only deps that would be fatal in the worklet bundle.
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
    // A single `vp test` aggregates node-side + browser e2e (SAB / postMessage)
    // into one stage. Via vitest 4's `projects` feature, each package's
    // vite.config.ts is the default project, and packages/core's two browser
    // configs run in parallel as separate projects.
    projects: [
      "packages/*/vite.config.ts",
      "packages/core/vite.browser.config.ts",
      "packages/core/vite.browser-postmessage.config.ts",
    ],
    // examples/demo is NOT aggregated here. It depends on `@vitejs/devtools`, whose
    // peer wiring spins up a second vite-plus-test runner that breaks this shared
    // collector (it hangs). The demo runs in its own CI jobs instead: the node suite
    // standalone (`cd examples/demo && vp test run`) and the runtime-compile browser
    // e2e on its own config (examples/demo/vite.browser.config.ts). The root's
    // default project collects nothing; every test comes from the projects above.
    include: [],
  },
});
