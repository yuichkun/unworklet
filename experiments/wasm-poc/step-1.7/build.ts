import binaryen from "binaryen";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const stepDir = dirname(fileURLToPath(import.meta.url));

// (module
//   (memory (export "memory") 1)
//   (func $process (export "process")
//     (local $i i32)
//     i32.const 0
//     local.set $i
//     (block $break
//       (loop $continue
//         local.get $i
//         i32.const 128
//         i32.ge_s
//         br_if $break
//
//         ;; output[i] (= memory[512 + i*4]) = input[i] (= memory[i*4]) * 0.5
//         local.get $i
//         i32.const 4
//         i32.mul
//         i32.const 512
//         i32.add               ;; output addr
//         local.get $i
//         i32.const 4
//         i32.mul
//         f32.load              ;; input[i]
//         f32.const 0.5
//         f32.mul               ;; input[i] * 0.5
//         f32.store
//
//         local.get $i
//         i32.const 1
//         i32.add
//         local.set $i
//         br $continue))))
const mod = new binaryen.Module();

mod.setMemory(1, 1, "memory");

mod.addFunction(
  "process",
  binaryen.none,
  binaryen.none,
  [binaryen.i32], // local i32 = counter
  mod.block(null, [
    mod.local.set(0, mod.i32.const(0)),

    mod.block("break", [
      mod.loop(
        "continue",
        mod.block(null, [
          // if (i >= 128) br $break
          mod.br_if("break", mod.i32.ge_s(mod.local.get(0, binaryen.i32), mod.i32.const(128))),

          // output[i] = input[i] * 0.5
          // f32.store(offset, align, ptr, value)
          //   ptr   = output_base + i * 4 = 512 + i*4
          //   value = f32.load(input_base + i * 4) * 0.5
          mod.f32.store(
            0,
            4,
            // ptr = 512 + i*4
            mod.i32.add(
              mod.i32.mul(mod.local.get(0, binaryen.i32), mod.i32.const(4)),
              mod.i32.const(512),
            ),
            // value = memory[i*4] * 0.5
            mod.f32.mul(
              mod.f32.load(0, 4, mod.i32.mul(mod.local.get(0, binaryen.i32), mod.i32.const(4))),
              mod.f32.const(0.5),
            ),
          ),

          // i = i + 1
          mod.local.set(0, mod.i32.add(mod.local.get(0, binaryen.i32), mod.i32.const(1))),

          // br $continue
          mod.br("continue"),
        ]),
      ),
    ]),
  ]),
);
mod.addFunctionExport("process", "process");

if (!mod.validate()) {
  throw new Error("binaryen module validation failed");
}

const wat = mod.emitText();
const wasm = mod.emitBinary();

writeFileSync(join(stepDir, "expected.wat"), wat);
writeFileSync(join(stepDir, "process.wasm"), wasm);

mod.dispose();

console.log("--- expected.wat ---");
console.log(wat);
console.log(`--- process.wasm: ${wasm.byteLength} bytes ---`);
