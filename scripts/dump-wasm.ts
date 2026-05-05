// Debug script: dump generated WASM text for a small processor
import { compileToWasm } from "@unworklet/compiler";
import * as P from "@unworklet/compiler/capture-primitives";
import * as D from "@unworklet/compiler/capture-decls";

const result = compileToWasm(
  () => {
    const main = D.audioInput({ channels: 1, name: "main" });
    const out = D.audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        D.forSample((i: any) => {
          const x = main.at(0, i);
          out.set(0, i, P.select(P.gt(x, 0.5), 0.5, x));
        });
      },
    };
  },
  { sampleRate: 48000 },
);

console.log(result.text);
