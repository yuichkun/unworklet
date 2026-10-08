import { fileURLToPath } from "node:url";
import type { Plugin } from "vite-plus";

import {
  compile,
  emitWorkletModuleSource,
  extractWorkletMeta,
} from "../packages/core/src/index.ts";
import type { CapturedGraph } from "../packages/core/src/compile/ast.ts";
import processor from "../packages/core/src/__tests__/browser/fixtures/native-rate.processor.ts";

const namespaceId = "\0native-rate-worklet";
const entryId = "\0native-rate-worklet-entry";
const wasmUrl = "/__native-rate-worklet.wasm";
const sourcePath = fileURLToPath(
  new URL(
    "../packages/core/src/__tests__/browser/fixtures/native-rate.processor.ts",
    import.meta.url,
  ),
);

/** Test-only manual delivery of the public compile-at-rate artifact. */
export function nativeRateWorklet(): Plugin {
  let compilation: ReturnType<typeof compile> | undefined;
  const artifact = () => (compilation ??= compile(processor, { sampleRate: 44100 }));
  return {
    name: "test-native-rate-worklet",
    async configureServer(server) {
      const { wasm } = await artifact();
      server.middlewares.use((request, response, next) => {
        if (request.url !== wasmUrl) return next();
        response.setHeader("Content-Type", "application/wasm");
        response.end(wasm);
      });
    },
    resolveId(id) {
      if (id === "virtual:native-rate-worklet") return namespaceId;
      if (id === namespaceId || id === entryId) return id;
    },
    async load(id) {
      if (id !== namespaceId && id !== entryId) return;
      const compiled = await artifact();
      if (id === entryId) {
        return emitWorkletModuleSource(
          extractWorkletMeta(compiled.graph as unknown as CapturedGraph),
          { processorName: "native-rate", runtime: { kind: "import" } },
        );
      }
      return `import processor from ${JSON.stringify(sourcePath)};
export default {
  ...processor,
  worklet: {
    ...processor.worklet,
    moduleUrl: "/@id/__x00__native-rate-worklet-entry",
    wasmUrl: ${JSON.stringify(wasmUrl)},
    processorName: "native-rate",
    bakedSampleRate: ${compiled.sampleRate},
  },
};`;
    },
  };
}
