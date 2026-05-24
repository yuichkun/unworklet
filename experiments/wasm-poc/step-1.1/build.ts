import binaryen from "binaryen";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const stepDir = dirname(fileURLToPath(import.meta.url));

// (module
//   (func $main (export "main") (result i32)
//     i32.const 42))
const mod = new binaryen.Module();

mod.addFunction(
  "main",
  binaryen.none,
  binaryen.i32,
  [],
  mod.i32.const(42),
);
mod.addFunctionExport("main", "main");

if (!mod.validate()) {
  throw new Error("binaryen module validation failed");
}

const wat = mod.emitText();
const wasm = mod.emitBinary();

writeFileSync(join(stepDir, "expected.wat"), wat);
writeFileSync(join(stepDir, "main.wasm"), wasm);

mod.dispose();

console.log("--- expected.wat ---");
console.log(wat);
console.log(`--- main.wasm: ${wasm.byteLength} bytes ---`);
