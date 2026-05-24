import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const stepDir = dirname(fileURLToPath(import.meta.url));
const wasm = readFileSync(join(stepDir, "process.wasm"));

const { instance } = await WebAssembly.instantiate(wasm);
const memory = instance.exports.memory as WebAssembly.Memory;

// input region = byte offset 0..511 (= 128 個 の f32)
const inputView = new Float32Array(memory.buffer, 0, 128);

// output region = byte offset 512..1023 (= 128 個 の f32)
const outputView = new Float32Array(memory.buffer, 512, 128);

// input PCM = 全 1.0 (= 128 sample)
for (let i = 0; i < 128; i++) {
  inputView[i] = 1.0;
}

// WASM process() 実 行 = output[i] = input[i] * 0.5 を 128 sample 分
// (= local 変 数 名 を runProcess に rename = Node global の `process` と 衝 突 回 避、
//    末 尾 の process.exit() は Node global を 参 照 す る た め)
const runProcess = instance.exports.process as () => void;
runProcess();

// 全 128 sample が 0.5 で あ る こ と を assert
let allOK = true;
for (let i = 0; i < 128; i++) {
  if (outputView[i] !== 0.5) {
    console.error(`✗ FAIL: output[${i}] = ${outputView[i]}, expected 0.5`);
    allOK = false;
    break;
  }
}

if (allOK) {
  console.log(`output[0..127] = 0.5 (= input[i] * 0.5、 全 128 sample)`);
  console.log("✓ PASS");
} else {
  process.exit(1);
}
