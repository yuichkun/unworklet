import { compile } from "@unworklet/core";
import { expect, test } from "vite-plus/test";

import { lowerToProcessor } from "./eval-lowered.ts";

for (const type of ["f32", "f64"] as const) {
  test(`.uwk.ts % preserves ${type} finite remainders through actual WASM`, async () => {
    const processor = lowerToProcessor(`
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  out.ch(0)[0] = f32(${type}(100000000) % ${type}(3));
  out.ch(0)[1] = f32(${type}(-100000000) % ${type}(3));
  out.ch(0)[2] = f32(${type}(1) % ${type}(0.1));
  out.ch(0)[3] = f32(${type}(100000002004087730000) % ${type}(3));
});`);
    const compiled = await compile(processor);
    const instance = await compiled.driver.instantiate();
    instance.process();
    const round = type === "f32" ? Math.fround : (value: number) => value;
    const expected = [
      [100_000_000, 3],
      [-100_000_000, 3],
      [1, 0.1],
      [100_000_002_004_087_730_000, 3],
    ].map(([a, b]) => Math.fround(round(a!) % round(b!)));
    const output = new Float32Array(128);
    instance.readOutput("main", 0, output);
    expect(Array.from(output.slice(0, 4))).toEqual(expected);
  });
}
