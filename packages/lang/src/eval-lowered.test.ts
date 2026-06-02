import { compile } from "@unworklet/core";
import { expect, test } from "vite-plus/test";

import { captureFsSnapshot } from "./capture.ts";
import { lowerToProcessor } from "./eval-lowered.ts";

const DISTORTION = `
const input = audioInput({ channels: 2, name: "main" });
const out   = audioOutput({ channels: 2, name: "main" });
const drive = param.f32({ default: 4, min: 1, max: 20, automationRate: "a-rate" }).named();
process(() => {
  forSample((i) => {
    const l = input.left[i] * drive[i];
    const r = input.right[i] * drive[i];
    out.left[i]  = l > 1 ? 1 : l < -1 ? -1 : l;
    out.right[i] = r > 1 ? 1 : r < -1 ? -1 : r;
  });
});`;

test("lowering off a captured snapshot compiles to a real (non-empty) WASM", async () => {
  // `@unworklet/lang/browser` bundles exactly this captured snapshot. If the
  // snapshot is incomplete, type-directed lowering silently no-ops, the index
  // writes stay raw, the process() body is dropped, and binaryen emits an
  // 88-byte stub WASM (the "browser is silent, no error" bug). Pin a real module
  // here, compiled off-disk through the same capture → lower path.
  const proc = lowerToProcessor(DISTORTION, captureFsSnapshot());
  const { wasm } = await compile(proc);
  expect((wasm as Uint8Array).byteLength).toBeGreaterThan(200);
});
