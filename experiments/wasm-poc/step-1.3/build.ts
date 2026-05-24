import binaryen from "binaryen";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const stepDir = dirname(fileURLToPath(import.meta.url));

// (module
//   (func $gain (export "gain") (param $sample f32) (result f32)
//     local.get $sample
//     f32.const 0.5
//     f32.mul))
const mod = new binaryen.Module();

mod.addFunction(
  "gain",
  binaryen.f32, // param types (= f32 1 個)
  binaryen.f32, // result type
  [], // local types (= ナ シ)
  mod.f32.mul(
    mod.local.get(0, binaryen.f32), // operand 1 = local.get 0
    mod.f32.const(0.5), // operand 2 = f32.const 0.5
  ),
);
mod.addFunctionExport("gain", "gain");

if (!mod.validate()) {
  throw new Error("binaryen module validation failed");
}

const wat = mod.emitText();
const wasm = mod.emitBinary();

writeFileSync(join(stepDir, "expected.wat"), wat);
writeFileSync(join(stepDir, "gain.wasm"), wasm);

mod.dispose();

console.log("--- expected.wat ---");
console.log(wat);
console.log(`--- gain.wasm: ${wasm.byteLength} bytes ---`);
