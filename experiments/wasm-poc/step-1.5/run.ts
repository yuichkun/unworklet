import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const stepDir = dirname(fileURLToPath(import.meta.url));
const wasm = readFileSync(join(stepDir, "applygain.wasm"));

const { instance } = await WebAssembly.instantiate(wasm);

const memory = instance.exports.memory as WebAssembly.Memory;
const view = new Float32Array(memory.buffer);

// host JS が view[0] に gain 値 0.5 を 書 込
view[0] = 0.5;

// WASM で applyGain(2.0) を 呼 ぶ = 2.0 × memory[0] = 2.0 × 0.5 = 1.0
const applyGain = instance.exports.applyGain as (sample: number) => number;
const result = applyGain(2.0);
console.log(`view[0] = 0.5、 applyGain(2.0) = ${result}`);

if (result !== 1.0) {
  console.error(`✗ FAIL: expected 1.0, got ${result}`);
  process.exit(1);
}
console.log("✓ PASS");
