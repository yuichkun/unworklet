import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const stepDir = dirname(fileURLToPath(import.meta.url));
const wasm = readFileSync(join(stepDir, "passthrough.wasm"));

const { instance } = await WebAssembly.instantiate(wasm);
const passthrough = instance.exports.passthrough as (x: number) => number;

const result = passthrough(7);
console.log(`passthrough(7) = ${result}`);

if (result !== 7) {
  console.error(`✗ FAIL: expected 7, got ${result}`);
  process.exit(1);
}
console.log("✓ PASS");
