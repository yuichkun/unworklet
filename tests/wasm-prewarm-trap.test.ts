// Pre-warm + trap handling tests.
import { expect, test } from "vite-plus/test";
import { compileToWasm } from "@unworklet/compiler";
import { stereoGain } from "@unworklet/examples";

test("WASM module exports a `prewarm` function and it runs without trapping", async () => {
  const result = compileToWasm(stereoGain, { sampleRate: 48000 });
  const mod = await WebAssembly.compile(result.binary as any);
  const inst = await WebAssembly.instantiate(mod, {
    math: {
      sin: Math.sin, cos: Math.cos, tan: Math.tan, tanh: Math.tanh,
      exp: Math.exp, log: Math.log, pow: Math.pow, atan2: Math.atan2,
    },
  });
  const exports = inst.exports as any;
  expect(typeof exports.prewarm).toBe("function");
  exports.init();
  // Run 256 prewarm iterations
  exports.prewarm(256);
  // After prewarm, normal process should still work
  exports.process(128);
  // No trap is success
});
