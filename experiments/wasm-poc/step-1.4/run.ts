import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const stepDir = dirname(fileURLToPath(import.meta.url));
const wasm = readFileSync(join(stepDir, "memload.wasm"));

const { instance } = await WebAssembly.instantiate(wasm);

// memory export を 取 得 + Float32Array view を 作 成 (= host JS と WASM の 共 有 ArrayBuffer)
const memory = instance.exports.memory as WebAssembly.Memory;
const view = new Float32Array(memory.buffer);

// host JS が view[0] (= byte 0..3 の f32) に 0.5 を 書 込
view[0] = 0.5;

// WASM が i32.const 0 + f32.load で 同 location を 読 む
const readGain = instance.exports.readGain as () => number;
const result = readGain();
console.log(`view[0] = 0.5、 readGain() = ${result}`);

if (result !== 0.5) {
  console.error(`✗ FAIL: expected 0.5, got ${result}`);
  process.exit(1);
}
console.log("✓ PASS");
