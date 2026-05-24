import binaryen from "binaryen";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const stepDir = dirname(fileURLToPath(import.meta.url));

// (module
//   (memory (export "memory") 1)
//   (func $applyGain (export "applyGain") (param $sample f32) (result f32)
//     local.get $sample
//     i32.const 0
//     f32.load
//     f32.mul))
const mod = new binaryen.Module();

mod.setMemory(1, 1, "memory");

mod.addFunction(
  "applyGain",
  binaryen.f32, // param types (= f32 1 個 = sample)
  binaryen.f32, // result type
  [], // local types
  // body = f32.mul(local.get(0), f32.load(0, 4, i32.const(0)))
  //      = sample × memory[0..3] (= host が 書 込 ん だ gain)
  mod.f32.mul(
    mod.local.get(0, binaryen.f32), // operand 1 = sample (= param 0)
    mod.f32.load(
      0, // offset
      4, // align
      mod.i32.const(0), // ptr = memory address 0
    ), // operand 2 = memory[0] (= gain)
  ),
);
mod.addFunctionExport("applyGain", "applyGain");

if (!mod.validate()) {
  throw new Error("binaryen module validation failed");
}

const wat = mod.emitText();
const wasm = mod.emitBinary();

writeFileSync(join(stepDir, "expected.wat"), wat);
writeFileSync(join(stepDir, "applygain.wasm"), wasm);

mod.dispose();

console.log("--- expected.wat ---");
console.log(wat);
console.log(`--- applygain.wasm: ${wasm.byteLength} bytes ---`);
