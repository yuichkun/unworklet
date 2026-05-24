import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const stepDir = dirname(fileURLToPath(import.meta.url));
const wasm = readFileSync(join(stepDir, "counter.wasm"));

const { instance } = await WebAssembly.instantiate(wasm);
const memory = instance.exports.memory as WebAssembly.Memory;
const view = new Int32Array(memory.buffer);

const countTo128 = instance.exports.countTo128 as () => void;
countTo128();

// memory[0..3] (= i32 view[0]) = counter 最 終 値 = 128 を 期 待
const result = view[0];
console.log(`memory[0] (= i32) = ${result}`);

if (result !== 128) {
  console.error(`✗ FAIL: expected 128, got ${result}`);
  process.exit(1);
}
console.log("✓ PASS");
