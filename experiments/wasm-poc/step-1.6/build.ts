import binaryen from "binaryen";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const stepDir = dirname(fileURLToPath(import.meta.url));

// (module
//   (memory (export "memory") 1)
//   (func $countTo128 (export "countTo128")
//     (local $i i32)
//     i32.const 0
//     local.set $i
//     (block $break
//       (loop $continue
//         local.get $i
//         i32.const 128
//         i32.ge_s
//         br_if $break
//         local.get $i
//         i32.const 1
//         i32.add
//         local.set $i
//         br $continue))
//     i32.const 0
//     local.get $i
//     i32.store))
const mod = new binaryen.Module();

mod.setMemory(1, 1, "memory");

mod.addFunction(
  "countTo128",
  binaryen.none, // param types
  binaryen.none, // result type
  [binaryen.i32], // local types = i32 1 個 (= counter)
  mod.block(null, [
    // i = 0
    mod.local.set(0, mod.i32.const(0)),

    // block $break (= forward escape target)
    mod.block("break", [
      // loop $continue (= backward jump target)
      mod.loop(
        "continue",
        mod.block(null, [
          // if (i >= 128) br $break (= forward escape)
          mod.br_if(
            "break",
            mod.i32.ge_s(
              mod.local.get(0, binaryen.i32),
              mod.i32.const(128),
            ),
          ),

          // i = i + 1
          mod.local.set(
            0,
            mod.i32.add(
              mod.local.get(0, binaryen.i32),
              mod.i32.const(1),
            ),
          ),

          // br $continue (= backward jump = loop 先 頭 に 戻 る)
          mod.br("continue"),
        ]),
      ),
    ]),

    // memory[0] = i (= i32.store の 4 引 数 = offset / align / ptr / value)
    mod.i32.store(
      0, // offset
      4, // align
      mod.i32.const(0), // ptr
      mod.local.get(0, binaryen.i32), // value = counter
    ),
  ]),
);
mod.addFunctionExport("countTo128", "countTo128");

if (!mod.validate()) {
  throw new Error("binaryen module validation failed");
}

const wat = mod.emitText();
const wasm = mod.emitBinary();

writeFileSync(join(stepDir, "expected.wat"), wat);
writeFileSync(join(stepDir, "counter.wasm"), wasm);

mod.dispose();

console.log("--- expected.wat ---");
console.log(wat);
console.log(`--- counter.wasm: ${wasm.byteLength} bytes ---`);
