import binaryen from "binaryen";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const stepDir = dirname(fileURLToPath(import.meta.url));

// (module
//   (memory (export "memory") 1)
//   (func $readGain (export "readGain") (result f32)
//     i32.const 0
//     f32.load))
const mod = new binaryen.Module();

// memory declare + export
// setMemory(initial pages, maximum pages, exportName)
// 1 page = 64 KB = 16384 個 の f32
mod.setMemory(1, 1, "memory");

mod.addFunction(
  "readGain",
  binaryen.none, // param types
  binaryen.f32, // result type
  [], // local types
  // body = f32.load(offset=0, align=4, ptr=i32.const(0))
  // → memory[0..3] (= byte 0 か ら 4 bytes) を f32 と し て 読 ん で stack に push
  mod.f32.load(
    0, // offset bytes (= immediate、 load address に 加 算)
    4, // align (= 4 bytes for f32)
    mod.i32.const(0), // address expression (= base ptr)
  ),
);
mod.addFunctionExport("readGain", "readGain");

if (!mod.validate()) {
  throw new Error("binaryen module validation failed");
}

const wat = mod.emitText();
const wasm = mod.emitBinary();

writeFileSync(join(stepDir, "expected.wat"), wat);
writeFileSync(join(stepDir, "memload.wasm"), wasm);

mod.dispose();

console.log("--- expected.wat ---");
console.log(wat);
console.log(`--- memload.wasm: ${wasm.byteLength} bytes ---`);
