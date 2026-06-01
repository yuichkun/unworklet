/**
 * Behavioral tests for `emitWorkletTemplate(...)` — the JS source emitter
 * that vite-plugin uses to construct the worklet runtime entry (= the file
 * loaded via `audioWorklet.addModule(url)` in the worklet realm)。
 *
 * Contract: the template embeds inline metadata + boots through
 * `@unworklet/core/worklet`'s `makeWorkletNamespaceFromMeta(...)`。 It MUST
 * NOT re-import the authoring processor source from the worklet realm
 * (= no `defineProcessor` re-evaluation on the audio thread,
 * `00-foundations.md` §5.1 + 04-worklet-runtime §2)。
 */

import {
  audioOutput,
  compile,
  defineProcessor,
  extractWorkletMeta,
  forSample,
  i64,
  state,
} from "@unworklet/core";
import { expect, test } from "vite-plus/test";

import { emitWorkletTemplate } from "./worklet-template.ts";

const META_FIXTURE = {
  layout: {
    regions: {
      ioScratch: {
        inputs: { main: 0 },
        outputs: { main: 1024 },
        params: { gain: 2048 },
      },
    },
  },
  audioInputs: [{ kind: "audioInput", name: "main", channels: 2 }],
  audioOutputs: [{ kind: "audioOutput", name: "main", channels: 2 }],
  params: [
    {
      kind: "param",
      name: "gain",
      default: 1,
      min: 0,
      max: 4,
      automationRate: "a-rate",
    },
  ],
} as unknown as Parameters<typeof emitWorkletTemplate>[0]["meta"];

test("emits a JS module that imports only from `@unworklet/core/worklet` (no authoring source)", () => {
  const out = emitWorkletTemplate({
    processorName: "stereoGain__abcd1234",
    meta: META_FIXTURE,
  });
  expect(out).toContain('from "@unworklet/core/worklet"');
  expect(out).toContain("makeWorkletNamespaceFromMeta");
  // The processor source must NOT be re-imported in the worklet realm。
  expect(out).not.toContain("/abs/");
  expect(out).not.toContain(".processor.ts");
  expect(out).not.toContain("defineProcessor");
});

test("inlines the WorkletMeta as a JSON literal next to the namespace bootstrap", () => {
  const out = emitWorkletTemplate({
    processorName: "stereoGain__abcd1234",
    meta: META_FIXTURE,
  });
  // The metadata appears in JSON form, not as a function call。
  const inlined = JSON.stringify(META_FIXTURE);
  expect(out).toContain(inlined);
  expect(out).toContain("makeWorkletNamespaceFromMeta(__unworkletMeta)");
});

test("emits a class extending AudioWorkletProcessor + registerProcessor call under the requested name", () => {
  const out = emitWorkletTemplate({
    processorName: "stereoGain__abcd1234",
    meta: META_FIXTURE,
  });
  expect(out).toContain("extends AudioWorkletProcessor");
  expect(out).toContain("registerProcessor");
  expect(out).toContain('"stereoGain__abcd1234"');
});

test("wires class methods to the namespace's 3 entries", () => {
  const out = emitWorkletTemplate({
    processorName: "stereoGain__abcd1234",
    meta: META_FIXTURE,
  });
  expect(out).toContain("__unworkletNs.parameterDescriptors");
  expect(out).toContain("__unworkletNs.initialize");
  expect(out).toContain("__unworkletNs.process");
});

test("JSON-escapes special characters in the processor name", () => {
  const out = emitWorkletTemplate({
    processorName: 'name "with quote"',
    meta: META_FIXTURE,
  });
  expect(out).toContain('"name \\"with quote\\""');
});

test("returns deterministic output for the same input", () => {
  const a = emitWorkletTemplate({
    processorName: "x",
    meta: META_FIXTURE,
  });
  const b = emitWorkletTemplate({
    processorName: "x",
    meta: META_FIXTURE,
  });
  expect(a).toBe(b);
});

test("emits a worklet entry for an i64 state without a BigInt serialization crash", async () => {
  // A real processor with an `i64` state — its `initial` is a `bigint`, which
  // `JSON.stringify` refuses to serialize. This is the exact metadata shape that
  // crashed the devtools-proto rack at `addModule` time ("Do not know how to
  // serialize a BigInt"); the emitter must round-trip the bigint as a JS literal.
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const count = state.i64(0n).named("count");
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(0);
          count.write(count.read().add(i64(1n)));
        });
      },
    };
  });
  await compile(proc);
  const meta = extractWorkletMeta(
    proc.graph as unknown as Parameters<typeof extractWorkletMeta>[0],
  );
  // Must not throw, and the i64 initial must survive as a BigInt literal (`0n`)
  // in the emitted JS source so the worklet realm reconstructs the real value.
  const emitted = emitWorkletTemplate({ processorName: "i64Counter__deadbeef", meta });
  expect(emitted).toContain('"initial":0n');
});
