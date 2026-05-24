import binaryen from "binaryen";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const stepDir = dirname(fileURLToPath(import.meta.url));

// (module
//   (func $passthrough (export "passthrough") (param $x i32) (result i32)
//     local.get $x))
const mod = new binaryen.Module();

mod.addFunction(
  "passthrough",
  binaryen.i32, // param types (= i32 1 個)
  binaryen.i32, // result type
  [], // local types (= ナ シ)
  mod.local.get(0, binaryen.i32), // body = local.get 0 (= 第 0 param)
);
mod.addFunctionExport("passthrough", "passthrough");

if (!mod.validate()) {
  throw new Error("binaryen module validation failed");
}

const wat = mod.emitText();
const wasm = mod.emitBinary();

writeFileSync(join(stepDir, "expected.wat"), wat);
writeFileSync(join(stepDir, "passthrough.wasm"), wasm);

mod.dispose();

console.log("--- expected.wat ---");
console.log(wat);
console.log(`--- passthrough.wasm: ${wasm.byteLength} bytes ---`);
