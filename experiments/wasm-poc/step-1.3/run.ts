import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const stepDir = dirname(fileURLToPath(import.meta.url));
const wasm = readFileSync(join(stepDir, "gain.wasm"));

const { instance } = await WebAssembly.instantiate(wasm);
const gain = instance.exports.gain as (sample: number) => number;

const result = gain(2.0);
console.log(`gain(2.0) = ${result}`);

if (result !== 1.0) {
  console.error(`✗ FAIL: expected 1.0, got ${result}`);
  process.exit(1);
}
console.log("✓ PASS");
