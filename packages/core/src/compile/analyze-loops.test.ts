import { expect, test } from "vite-plus/test";

import "../dsl/primitives.ts";
import { f32 } from "../dsl/constructors.ts";
import { audioOutput, event, state } from "../dsl/declarations.ts";
import { forSample } from "../dsl/loop.ts";
import { defineProcessor } from "../processor.ts";
import { compile } from "./index.ts";
import type { Layout } from "./layout.ts";

type Scope = "process" | "message" | "MIDI";

function inScope(scope: Scope, body: () => void): () => void {
  if (scope === "message") {
    const input = event<void>({ from: "main", name: "input", capacity: 16 });
    return () => input.onReceive(body);
  }
  if (scope === "MIDI") {
    const input = event.midi({ from: "main", name: "input", capacity: 16 });
    return () => input.onEvent("noteOn", body);
  }
  return body;
}

for (const scope of ["process", "message", "MIDI"] as const) {
  test.each([0, -1, 3, 1.5, 256, NaN, Infinity])(
    `${scope} rejects forSample.byN stride %s at compilation`,
    async (stride) => {
      const processor = defineProcessor(() => ({
        process: inScope(scope, () => forSample.byN(stride, () => {})),
      }));
      await expect(compile(processor)).rejects.toThrow(/\[illegal-stride\]/);
    },
  );

  test.each([0, -2, 3.5, NaN, Infinity])(
    `${scope} rejects everyNSamples divisor %s at compilation`,
    async (divisor) => {
      const processor = defineProcessor(() => ({
        process: inScope(scope, () => {
          forSample((_i, everyNSamples) => everyNSamples(divisor, () => {}));
        }),
      }));
      await expect(compile(processor)).rejects.toThrow(/\[illegal-everyn-divisor\]/);
    },
  );

  test(`${scope} validates loops nested inside forSample and everyNSamples bodies`, async () => {
    const processor = defineProcessor(() => ({
      process: inScope(scope, () => {
        forSample((_i, everyNSamples) => {
          everyNSamples(3, () => {
            forSample.byN(3, (_j, everyNestedSamples) => {
              everyNestedSamples(0, () => {});
            });
          });
        });
      }),
    }));
    await expect(compile(processor)).rejects.toThrow(
      /\[illegal-stride\][\s\S]*\[illegal-everyn-divisor\]/,
    );
  });

  test.each([
    [1, 1],
    [2, 3],
    [4, 48],
    [8, 256],
    [16, 3],
    [32, 48],
    [64, 1],
    [128, 256],
  ])(`${scope} executes valid stride %s and divisor %s in WASM`, async (stride, divisor) => {
    const processor = defineProcessor(() => {
      const out = audioOutput({ channels: 1, name: "out" });
      const count = state.i32(0);
      const process = inScope(scope, () => {
        forSample.byN(stride, (_i, everyNSamples) => {
          everyNSamples(divisor, () => count.write(count.read().add(1)));
        });
      });
      return {
        process: () => {
          process();
          forSample((i) => out.ch(0).at(i).write(f32(count.read())));
        },
      };
    });
    const compiled = await compile(processor);
    expect(compiled.diagnostics).toEqual([]);
    const instance = await compiled.driver.instantiate();
    const memory = compiled.memory as unknown as Layout;
    const ring =
      scope === "message"
        ? memory.regions.messageRings.slots.input
        : memory.regions.midiRings.slots.input;
    const view = new DataView(instance.memory.buffer);
    const output = new Float32Array(128);
    let expected = 0;
    let counter = 0;
    for (let block = 0; block < 3; block++) {
      if (ring) {
        view.setUint32(ring.base, block + 1, true);
        if (scope === "MIDI") {
          new Uint8Array(instance.memory.buffer).set([0x90, 60, 100], ring.base + 12 + block * 8);
        }
      }
      for (let sample = 0; sample < 128; sample += stride) {
        if (counter % divisor === 0) expected++;
        counter += stride;
      }
      instance.process();
      instance.readOutput("out", 0, output);
      expect([...output]).toEqual(Array<number>(128).fill(expected));
      if (ring) expect(view.getUint32(ring.base + 4, true)).toBe(block + 1);
    }
  });
}
