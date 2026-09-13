import { expect, test } from "vite-plus/test";

import "../dsl/primitives.ts";
import { bool, f32, f64, i64 } from "../dsl/constructors.ts";
import { audioOutput, event, noiseSource, state } from "../dsl/declarations.ts";
import { forSample } from "../dsl/loop.ts";
import { defineProcessor } from "../processor.ts";
import { splat, sumLanes, vec4 } from "../simd.ts";
import { render } from "../__tests__/behavior/render.ts";
import { compile } from "./index.ts";
import type { Layout } from "./layout.ts";

test("noise sources keep independent repeatable streams across blocks and instances", async () => {
  const processor = defineProcessor(() => {
    const out = audioOutput({ name: "main", channels: 3 });
    const sources = [noiseSource(), noiseSource({}), noiseSource({ seed: 0 })];
    return {
      process: () => {
        forSample((i) => {
          for (let channel = 0; channel < sources.length; channel++) {
            out.ch(channel).at(i).write(sources[channel]!.next());
          }
        });
      },
    };
  });
  const first = (await render(processor, { blocks: 2 })).outputs.main!;
  const repeat = (await render(processor, { blocks: 2 })).outputs.main!;
  expect(first).toEqual(repeat);
  expect(first[0]).not.toEqual(first[1]);
  expect(first[1]).not.toEqual(first[2]);
  for (const channel of first) {
    expect(channel.slice(0, 128)).not.toEqual(channel.slice(128));
    expect(new Set(channel).size).toBeGreaterThan(200);
    for (const sample of channel) {
      expect(sample).toBeGreaterThanOrEqual(-1);
      expect(sample).toBeLessThan(1);
    }
  }
});

test("numeric truth conversion and boolean widening preserve zero and nonzero values", async () => {
  const processor = defineProcessor(() => {
    const out = audioOutput({ name: "main", channels: 7 });
    const precise = state.f64(0.125);
    const enabled = state.bool(true);
    return {
      process: () => {
        forSample((i) => {
          out
            .ch(0)
            .at(i)
            .write(f32(bool(i64(0n))));
          out
            .ch(1)
            .at(i)
            .write(f32(bool(i64(-4n))));
          out
            .ch(2)
            .at(i)
            .write(f32(bool(f32(0))));
          out
            .ch(3)
            .at(i)
            .write(f32(bool(f32(-0.25))));
          out
            .ch(4)
            .at(i)
            .write(f32(f64(enabled.read())));
          out.ch(5).at(i).write(f32(precise.read()));
          out
            .ch(6)
            .at(i)
            .write(f32(bool(f64(0))));
        });
      },
    };
  });
  const output = (await render(processor)).outputs.main!;
  for (const [channel, expected] of [0, 1, 0, 1, 1, 0.125, 0].entries()) {
    expect(Array.from(output[channel]!)).toEqual(Array(128).fill(expected));
  }
});

test("vector method arithmetic preserves every lane with scalar operands", async () => {
  const processor = defineProcessor(() => {
    const out = audioOutput({ name: "main", channels: 1 });
    return {
      process: () => {
        forSample((i) => {
          const computed = vec4(2, 4, 6, 8).add(2).sub(splat(1)).div(2);
          out.ch(0).at(i).write(sumLanes(computed));
        });
      },
    };
  });
  expect(Array.from((await render(processor)).outputs.main![0]!)).toEqual(Array(128).fill(12));
});

test("all fixed-slot MIDI handlers forward the complete wire values and timestamps", async () => {
  const processor = defineProcessor(() => {
    const input = event.midi({ from: "main", name: "input", capacity: 16 });
    const output = event.midi({ to: "main", name: "output", capacity: 16 });
    return {
      process: () => {
        input.onEvent("noteOn", (data) => output.emitIf(true, data));
        input.onEvent("noteOff", (data) => output.emitIf(true, data));
        input.onEvent("cc", (data) => output.emitIf(true, data));
        input.onEvent("pitchBend", (data) => output.emitIf(true, data));
        input.onEvent("programChange", (data) => output.emitIf(true, data));
        input.onEvent("channelPressure", (data) => output.emitIf(true, data));
        input.onEvent("aftertouch", (data) => output.emitIf(true, data));
        input.onEvent("systemRealtime", (data) => output.emitIf(true, data));
        output.emitIf(false, { type: "systemRealtime", status: 0xf8, atSample: 0 });
      },
    };
  });
  const result = await compile(processor);
  const instance = await result.driver.instantiate();
  const memory = result.memory as unknown as Layout;
  const input = memory.regions.midiRings.slots.input!;
  const output = memory.regions.midiRings.slots.output!;
  const bytes = new Uint8Array(instance.memory.buffer);
  const view = new DataView(instance.memory.buffer);
  const messages = [
    [0x93, 60, 100],
    [0x83, 60, 45],
    [0xb7, 74, 100],
    [0xe2, 1, 64],
    [0xc5, 33, 0],
    [0xd4, 97, 0],
    [0xa6, 61, 78],
    [0xfa, 0, 0],
  ];
  for (const [index, message] of messages.entries()) {
    bytes.set(message, input.base + 12 + index * 8);
    view.setUint32(input.base + 12 + index * 8 + 4, index * 3, true);
  }
  view.setUint32(input.base, messages.length, true);
  instance.process();
  expect(view.getUint32(input.base + 4, true)).toBe(messages.length);
  expect(view.getUint32(output.base, true)).toBe(messages.length);
  for (const [index, message] of messages.entries()) {
    const offset = output.base + 12 + index * 8;
    expect(Array.from(bytes.slice(offset, offset + 3))).toEqual(message);
    expect(view.getUint32(offset + 4, true)).toBe(index * 3);
  }
});

test("sysex thru preserves bytes, length, and timestamp without an intermediate buffer", async () => {
  const processor = defineProcessor(() => {
    const input = event.midi({ from: "main", name: "input", capacity: 16 });
    const output = event.midi({ to: "main", name: "output", capacity: 16 });
    return { process: () => input.onEvent("sysex", (data) => output.emitIf(true, data)) };
  });
  const result = await compile(processor);
  const instance = await result.driver.instantiate();
  const memory = result.memory as unknown as Layout;
  const input = memory.regions.midiRings.slots.input!;
  const output = memory.regions.midiRings.slots.output!;
  const inContent = memory.regions.sysexContent.slots.input!;
  const outContent = memory.regions.sysexContent.slots.output!;
  const view = new DataView(instance.memory.buffer);
  const bytes = new Uint8Array(instance.memory.buffer);
  const message = [0xf0, 0x7d, 1, 2, 3, 0xf7];
  view.setUint32(input.base, 1, true);
  bytes[input.base + 12] = 0xf0;
  view.setUint32(input.base + 16, 27, true);
  view.setUint32(inContent.base, message.length, true);
  bytes.set(message, inContent.base + 4);
  instance.process();
  expect(view.getUint32(output.base, true)).toBe(1);
  expect(bytes[output.base + 12]).toBe(0xf0);
  expect(view.getUint32(output.base + 16, true)).toBe(27);
  expect(view.getUint32(outContent.base, true)).toBe(message.length);
  expect(
    Array.from(bytes.slice(outContent.base + 4, outContent.base + 4 + message.length)),
  ).toEqual(message);
});

test("an empty sub-rate callback still advances its cadence without trapping", async () => {
  const processor = defineProcessor(() => ({
    process: () => forSample((_, everyNSamples) => everyNSamples(5, () => {})),
  }));
  const compiled = await compile(processor);
  const instance = await compiled.driver.instantiate();
  const memory = compiled.memory as unknown as Layout;
  const counter = Object.values(memory.regions.everyNSamplesCounters.slots)[0]!;
  instance.process();
  instance.process();
  expect(new DataView(instance.memory.buffer).getUint32(counter, true)).toBe(256);
});

test("an empty MIDI handler consumes matching messages without emitting output", async () => {
  const processor = defineProcessor(() => {
    const input = event.midi({ from: "main", name: "input", capacity: 16 });
    return { process: () => input.onEvent("systemRealtime", () => {}) };
  });
  const compiled = await compile(processor);
  const instance = await compiled.driver.instantiate();
  const memory = compiled.memory as unknown as Layout;
  const input = memory.regions.midiRings.slots.input!;
  const view = new DataView(instance.memory.buffer);
  view.setUint32(input.base, 1, true);
  view.setUint8(input.base + 12, 0xf8);
  instance.process();
  expect(view.getUint32(input.base + 4, true)).toBe(1);
});

test("unsigned byte interpolation returns the truncated interpolated integer", async () => {
  const processor = defineProcessor(() => {
    const bytes = state.buffer.u8({ size: 4 });
    const out = audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        bytes.write(0, 10);
        bytes.write(1, 21);
        forSample((i) =>
          out
            .ch(0)
            .at(i)
            .write(f32(bytes.readInterpolated(0.5))),
        );
      },
    };
  });
  expect(Array.from((await render(processor)).outputs.main![0]!)).toEqual(Array(128).fill(15));
});

test.each([
  ["constant", () => vec4(1, 2, 3, 4)],
  ["splat", () => splat(1)],
  ["addition", () => splat(1).add(splat(2))],
  ["subtraction", () => splat(1).sub(splat(2))],
  ["multiplication", () => splat(1).mul(splat(2))],
  ["division", () => splat(1).div(splat(2))],
  ["buffer load", () => state.buffer.f32({ size: 4 }).loadVec(0)],
] as const)("a vector %s cannot be written as a scalar audio sample", async (_, makeVector) => {
  const processor = defineProcessor(() => {
    const vector = makeVector();
    const out = audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        // @ts-expect-error Runtime backstop for JavaScript callers mixing vector and scalar signals.
        out.ch(0).at(0).write(vector);
      },
    };
  });
  await expect(compile(processor)).rejects.toThrow(/f32x4 node.*cannot appear in scalar position/);
});
