import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const stepDir = dirname(fileURLToPath(import.meta.url));
const wasm = readFileSync(join(stepDir, "main.wasm"));

const { instance } = await WebAssembly.instantiate(wasm);
const main = instance.exports.main as () => number;

const result = main();
console.log(`main() = ${result}`);

if (result !== 42) {
  console.error(`✗ FAIL: expected 42, got ${result}`);
  process.exit(1);
}
console.log("✓ PASS");
