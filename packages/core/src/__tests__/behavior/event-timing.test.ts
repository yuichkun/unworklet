import { expect, test } from "vite-plus/test";

import "../../dsl/primitives.ts";
import { compile } from "../../compile/index.ts";
import type { Layout } from "../../compile/layout.ts";
import { event } from "../../dsl/declarations.ts";
import { forSample } from "../../dsl/loop.ts";
import { defineProcessor } from "../../processor.ts";
import type { CompiledProcessor, Node } from "../../types.ts";

function timingOutputs() {
  const output = event<{ value: number }>({ to: "main", name: "output", capacity: 64 });
  const midi = event.midi({ to: "main", name: "midi", capacity: 64 });
  return (cond: Node<"bool"> | boolean, atSample?: Node<"i32"> | number) => {
    output.emitIf(cond, { value: 1, atSample });
    const note = { type: "noteOn" as const, channel: 0, note: 60, velocity: 100 };
    if (atSample === undefined) {
      // Exercise the runtime fallback without making MIDI atSample optional in TypeScript.
      // @ts-expect-error -- MIDI callers must supply atSample.
      midi.emitIf(cond, note);
    } else {
      midi.emitIf(cond, { ...note, atSample });
    }
  };
}

async function timingInstance<C>(processor: CompiledProcessor<C>) {
  const compiled = await compile(processor);
  expect(compiled.diagnostics).toEqual([]);
  const instance = await compiled.driver.instantiate();
  const memory = compiled.memory as unknown as Layout;
  const view = new DataView(instance.memory.buffer);
  return {
    instance,
    memory,
    view,
    offsets: () => {
      const output = memory.regions.eventRings.slots.output!;
      const midi = memory.regions.midiRings.slots.midi!;
      const count = view.getUint32(output.base, true);
      expect(view.getUint32(midi.base, true)).toBe(count);
      expect(view.getUint32(output.base + 8, true)).toBe(0);
      expect(view.getUint32(midi.base + 8, true)).toBe(0);
      const eventOffsets: number[] = [];
      const midiOffsets: number[] = [];
      for (let index = 0; index < count; index++) {
        const eventSlot = output.base + 12 + index * output.slotSize;
        const midiSlot = midi.base + 12 + index * 8;
        expect(view.getFloat32(eventSlot + output.fields[1]!.offsetInSlot, true)).toBe(1);
        expect(Array.from(new Uint8Array(instance.memory.buffer, midiSlot, 3))).toEqual([
          0x90, 60, 100,
        ]);
        eventOffsets.push(view.getInt32(eventSlot, true));
        midiOffsets.push(view.getInt32(midiSlot + 4, true));
      }
      return { event: eventOffsets, midi: midiOffsets };
    },
  };
}

test("nested event and MIDI emissions use the inner sample and restore the outer sample", async () => {
  const processor = defineProcessor(() => {
    const emit = timingOutputs();
    return {
      process: () => {
        forSample((outer) => {
          forSample((inner) => emit(outer.eq(0).and(inner.eq(7))));
          emit(outer.eq(9));
        });
      },
    };
  });
  const runtime = await timingInstance(processor);
  runtime.instance.process();
  expect(runtime.offsets()).toEqual({ event: [7, 9], midi: [7, 9] });
});

for (const handler of ["message", "MIDI"] as const) {
  test(`${handler} handler emissions use block start after a completed sample loop`, async () => {
    const processor = defineProcessor(() => {
      const emit = timingOutputs();
      const message = event<void>({ from: "main", name: "trigger", capacity: 16 });
      const midi = event.midi({ from: "main", name: "trigger", capacity: 16 });
      const body = () => {
        forSample(() => {});
        emit(true);
      };
      return {
        process: () => {
          if (handler === "message") message.onReceive(body);
          else midi.onEvent("noteOn", body);
        },
      };
    });
    const runtime = await timingInstance(processor);
    const input =
      handler === "message"
        ? runtime.memory.regions.messageRings.slots.trigger!
        : runtime.memory.regions.midiRings.slots.trigger!;
    runtime.view.setUint32(input.base, 1, true);
    if (handler === "MIDI") {
      new Uint8Array(runtime.instance.memory.buffer).set([0x90, 60, 100], input.base + 12);
      runtime.view.setUint32(input.base + 16, 23, true);
    }
    runtime.instance.process();
    expect(runtime.view.getUint32(input.base + 4, true)).toBe(1);
    expect(runtime.offsets()).toEqual({ event: [0], midi: [0] });
  });
}

test("nested everyNSamples emissions retain inner sample offsets across blocks", async () => {
  const processor = defineProcessor(() => {
    const emit = timingOutputs();
    return {
      process: () => {
        forSample.byN(128, () => {
          forSample((_inner, everyNSamples) => everyNSamples(50, () => emit(true)));
        });
      },
    };
  });
  const runtime = await timingInstance(processor);
  runtime.instance.process();
  expect(runtime.offsets()).toEqual({ event: [0, 50, 100], midi: [0, 50, 100] });
  runtime.instance.process();
  expect(runtime.offsets()).toEqual({
    event: [0, 50, 100, 22, 72, 122],
    midi: [0, 50, 100, 22, 72, 122],
  });
});

test("strided sample loops use the sample offset rather than the iteration count", async () => {
  const processor = defineProcessor(() => {
    const emit = timingOutputs();
    return { process: () => forSample.byN(4, (i) => emit(i.eq(12))) };
  });
  const runtime = await timingInstance(processor);
  runtime.instance.process();
  expect(runtime.offsets()).toEqual({ event: [12], midi: [12] });
});

test("explicit numeric and computed offsets override nested sample defaults", async () => {
  const processor = defineProcessor(() => {
    const emit = timingOutputs();
    return {
      process: () => {
        forSample.byN(128, () => {
          forSample((inner) => {
            emit(inner.eq(7), 42);
            emit(inner.eq(7), inner.add(2));
          });
        });
        emit(true, 64);
      },
    };
  });
  const runtime = await timingInstance(processor);
  runtime.instance.process();
  expect(runtime.offsets()).toEqual({ event: [42, 9, 64], midi: [42, 9, 64] });
});

test("explicit handler offsets preserve both inbound timing and numeric overrides", async () => {
  const processor = defineProcessor(() => {
    const emit = timingOutputs();
    const input = event.midi({ from: "main", name: "input", capacity: 16 });
    return {
      process: () => {
        input.onEvent("noteOn", (data) => {
          forSample(() => {});
          emit(true, data.atSample);
          emit(true, 42);
        });
      },
    };
  });
  const runtime = await timingInstance(processor);
  const input = runtime.memory.regions.midiRings.slots.input!;
  runtime.view.setUint32(input.base, 1, true);
  new Uint8Array(runtime.instance.memory.buffer).set([0x90, 60, 100], input.base + 12);
  runtime.view.setUint32(input.base + 16, 23, true);
  runtime.instance.process();
  expect(runtime.offsets()).toEqual({ event: [23, 42], midi: [23, 42] });
});
