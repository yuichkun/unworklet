import { Worker } from "node:worker_threads";
import { expect, test } from "vite-plus/test";

import "../dsl/primitives.ts";
import { f32, f64, i32 } from "../dsl/constructors.ts";
import { audioOutput, event, noiseSource, state } from "../dsl/declarations.ts";
import { forSample } from "../dsl/loop.ts";
import { defineProcessor } from "../processor.ts";
import { sumLanes, vec4 } from "../simd.ts";
import { render } from "../__tests__/behavior/render.ts";
import { compile } from "./index.ts";
import type { Layout } from "./layout.ts";

async function processBounded(wasm: Uint8Array, initial: ArrayBuffer): Promise<ArrayBuffer> {
  const worker = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
     WebAssembly.instantiate(workerData.wasm).then(({ instance }) => {
       const memory = instance.exports.memory;
       new Uint8Array(memory.buffer).set(new Uint8Array(workerData.initial));
       instance.exports.process();
       parentPort.postMessage(memory.buffer);
     }).catch(error => { throw error; });`,
    { eval: true, workerData: { wasm, initial } },
  );
  try {
    return await new Promise<ArrayBuffer>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("process did not return within 2 seconds")),
        2_000,
      );
      worker.once("message", (memory: ArrayBuffer) => {
        clearTimeout(timeout);
        resolve(memory);
      });
      worker.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  } finally {
    await worker.terminate();
  }
}

test("message handlers can reply repeatedly and keep reading their input fields", async () => {
  const processor = defineProcessor(() => {
    const input = event<{ value: number }>({ from: "main", name: "input", capacity: 16 });
    const first = event<{ value: number }>({ to: "main", name: "first", capacity: 16 });
    const second = event<{ value: number }>({ to: "main", name: "second", capacity: 16 });
    return {
      process: () =>
        input.onReceive((data) => {
          first.emitIf(true, { value: data.value });
          second.emitIf(true, { value: data.value.add(1) });
        }),
    };
  });
  const compiled = await compile(processor);
  const instance = await compiled.driver.instantiate();
  const memory = compiled.memory as unknown as Layout;
  const input = memory.regions.messageRings.slots.input!;
  const view = new DataView(instance.memory.buffer);
  view.setUint32(input.base, 2, true);
  for (const [index, value] of [17, 29].entries()) {
    view.setFloat32(
      input.base + 12 + index * input.slotSize + input.fields[0]!.offsetInSlot,
      value,
      true,
    );
  }
  const result = new DataView(
    await processBounded(compiled.wasm, instance.memory.buffer as ArrayBuffer),
  );
  expect(result.getUint32(input.base + 4, true)).toBe(2);
  for (const [name, delta] of [
    ["first", 0],
    ["second", 1],
  ] as const) {
    const output = memory.regions.eventRings.slots[name]!;
    expect(result.getUint32(output.base, true)).toBe(2);
    for (const [index, value] of [17, 29].entries()) {
      expect(
        result.getFloat32(
          output.base +
            12 +
            index * output.slotSize +
            output.fields.find((field) => field.name === "value")!.offsetInSlot,
          true,
        ),
      ).toBe(value + delta);
    }
  }
});

test("MIDI handlers keep their input slot through event replies and multiple MIDI replies", async () => {
  const processor = defineProcessor(() => {
    const input = event.midi({ from: "main", name: "input", capacity: 16 });
    const first = event.midi({ to: "main", name: "first", capacity: 16 });
    const second = event.midi({ to: "main", name: "second", capacity: 16 });
    const notes = event<{ note: number }>({ to: "main", name: "notes", capacity: 16 });
    return {
      process: () => {
        input.onEvent("noteOn", (data) => {
          notes.emitIf(true, { note: f32(data.note) });
          first.emitIf(true, data);
          second.emitIf(true, data);
        });
        input.onEvent("noteOn", (data) => notes.emitIf(true, { note: f32(data.velocity) }));
      },
    };
  });
  const compiled = await compile(processor);
  const instance = await compiled.driver.instantiate();
  const memory = compiled.memory as unknown as Layout;
  const input = memory.regions.midiRings.slots.input!;
  const view = new DataView(instance.memory.buffer);
  const bytes = new Uint8Array(instance.memory.buffer);
  view.setUint32(input.base, 2, true);
  bytes.set([0x93, 60, 91, 0, 7, 0, 0, 0, 0x95, 72, 103, 0, 29, 0, 0, 0], input.base + 12);
  const result = await processBounded(compiled.wasm, instance.memory.buffer as ArrayBuffer);
  const resultView = new DataView(result);
  expect(resultView.getUint32(input.base + 4, true)).toBe(2);
  for (const name of ["first", "second"]) {
    const output = memory.regions.midiRings.slots[name]!;
    expect(resultView.getUint32(output.base, true)).toBe(2);
    expect(new Uint8Array(result, output.base + 12, 16)).toEqual(
      bytes.slice(input.base + 12, input.base + 28),
    );
  }
  const notes = memory.regions.eventRings.slots.notes!;
  expect(resultView.getUint32(notes.base, true)).toBe(4);
  expect(
    [0, 1, 2, 3].map((index) =>
      resultView.getFloat32(
        notes.base +
          12 +
          index * notes.slotSize +
          notes.fields.find((field) => field.name === "note")!.offsetInSlot,
        true,
      ),
    ),
  ).toEqual([60, 91, 72, 103]);
});

test("sysex handlers forward, copy, and reread the same message through multiple outputs", async () => {
  const processor = defineProcessor(() => {
    const input = event.midi({ from: "main", name: "input", capacity: 16 });
    const first = event.midi({ to: "main", name: "first", capacity: 16 });
    const second = event.midi({ to: "main", name: "second", capacity: 16 });
    const saved = state.buffer.u8({ size: 16 }).named("saved");
    return {
      process: () =>
        input.onEvent("sysex", (data) => {
          first.emitIf(true, data);
          saved.copyFrom(data.data);
          second.emitIf(true, data);
        }),
    };
  });
  const compiled = await compile(processor);
  const instance = await compiled.driver.instantiate();
  const memory = compiled.memory as unknown as Layout;
  const input = memory.regions.midiRings.slots.input!;
  const content = memory.regions.sysexContent.slots.input!;
  const view = new DataView(instance.memory.buffer);
  const bytes = new Uint8Array(instance.memory.buffer);
  const message = [0xf0, 0x7d, 7, 8, 0xf7];
  view.setUint32(input.base, 2, true);
  view.setUint32(input.base + 4, 1, true);
  bytes[input.base + 20] = 0xf0;
  view.setUint16(input.base + 21, 1, true);
  view.setUint32(input.base + 24, 23, true);
  view.setUint32(content.base + content.perChunk, message.length, true);
  bytes.set(message, content.base + content.perChunk + 4);
  const result = await processBounded(compiled.wasm, instance.memory.buffer as ArrayBuffer);
  for (const name of ["first", "second"]) {
    const output = memory.regions.midiRings.slots[name]!;
    const payload = memory.regions.sysexContent.slots[name]!;
    const resultView = new DataView(result);
    expect(resultView.getUint32(output.base, true)).toBe(1);
    expect(resultView.getUint32(output.base + 16, true)).toBe(23);
    expect(resultView.getUint32(payload.base, true)).toBe(message.length);
    expect(Array.from(new Uint8Array(result, payload.base + 4, message.length))).toEqual(message);
  }
  expect(
    Array.from(new Uint8Array(result, memory.regions.buffers.slots.saved!, message.length)),
  ).toEqual(message);
});

test("nested arithmetic, interpolation, SIMD, and captured noise keep independent values", async () => {
  const processor = defineProcessor(() => {
    const output = audioOutput({ name: "main", channels: 6 });
    const values = state.buffer.f32({ size: 8 });
    const noise = noiseSource({ seed: 123 });
    const counter = state.f32(0);
    return {
      process: () => {
        forSample((i) => {
          const once = noise.next();
          const captured = counter.read();
          counter.write(captured.add(1));
          values.write(0, 1);
          values.write(1, 3);
          values.storeVec(
            i32(sumLanes(vec4(1, 1, 1, 1))),
            vec4(
              values.readInterpolated(f32(5.5).frac().frac()),
              f32(17).mod(f32(8).mod(5)),
              f32(f64(23).mod(f64(11).mod(7))),
              once,
            ),
          );
          output
            .ch(0)
            .at(i)
            .write(sumLanes(values.loadVec(4)).sub(once));
          output.ch(1).at(i).write(once.sub(once));
          output.ch(2).at(i).write(captured);
          output.ch(4).at(i).write(once);
          output
            .ch(5)
            .at(i)
            .write(f32(f64(9.25).frac().frac()));
          output
            .ch(3)
            .at(i)
            .write(values.readInterpolated(values.readInterpolated(0.25).sub(1)));
        });
      },
    };
  });
  const first = (await render(processor)).outputs.main!;
  for (const sample of first[0]!) expect(sample).toBeCloseTo(7, 5);
  expect(Array.from(first[1]!)).toEqual(Array(128).fill(0));
  expect(Array.from(first[2]!)).toEqual(Array.from({ length: 128 }, (_, index) => index));
  expect(Array.from(first[3]!)).toEqual(Array(128).fill(2));
  const expectedNoise = [];
  let hash = 123;
  for (let index = 0; index < 128; index++) {
    hash ^= hash << 13;
    hash ^= hash >>> 17;
    hash ^= hash << 5;
    expectedNoise.push((hash >> 8) / 8388608);
  }
  expect(Array.from(first[4]!)).toEqual(expectedNoise);
  expect(Array.from(first[5]!)).toEqual(Array(128).fill(0.25));
});

test("sequential writes reuse scratch storage without increasing process local count", async () => {
  const binaryen = (await import("binaryen")).default;
  const localCounts = [];
  for (const writes of [1, 512]) {
    const processor = defineProcessor(() => {
      const value = state.f32(0);
      return {
        process: () => {
          for (let index = 0; index < writes; index++) value.write(index);
        },
      };
    });
    const compiled = await compile(processor);
    const mod = binaryen.readBinary(compiled.wasm);
    try {
      localCounts.push(binaryen.getFunctionInfo(mod.getFunctionByIndex(0)).vars.length);
    } finally {
      mod.dispose();
    }
    const instance = await compiled.driver.instantiate();
    instance.process();
    const memory = compiled.memory as unknown as Layout;
    const offset = Object.values(memory.regions.states.slots)[0]!;
    expect(new DataView(instance.memory.buffer).getFloat32(offset, true)).toBe(writes - 1);
  }
  expect(localCounts[1]).toBe(localCounts[0]);
});
