/**
 * renderOffline renders in blocks of the compiled render quantum. For a
 * processor without per-block behaviour (no handlers, no per-block statements,
 * no k-rate params, no publish), the output does not depend on the quantum.
 */

import {
  audioInput,
  audioOutput,
  defineProcessor,
  event,
  f32,
  forSample,
  i32,
  select,
  sin,
  state,
} from "@unworklet/core";
import { expect, test } from "vite-plus/test";

import { renderOffline } from "./index.ts";

const sine = defineProcessor((ctx) => {
  const out = audioOutput({ channels: 1, name: "main" });
  const phase = state.f32(0);
  return {
    process: () => {
      forSample((i) => {
        phase.write(
          phase
            .read()
            .add(440 / ctx.sampleRate)
            .mod(1),
        );
        out
          .ch(0)
          .at(i)
          .write(sin(phase.read().mul(2 * Math.PI)));
      });
    },
  };
});

const onePole = defineProcessor(() => {
  const input = audioInput({ channels: 1, name: "main" });
  const out = audioOutput({ channels: 1, name: "main" });
  const y = state.f32(0);
  return {
    process: () => {
      forSample((i) => {
        y.write(y.read().add(input.ch(0).at(i).sub(y.read()).mul(f32(0.05))));
        out.ch(0).at(i).write(y.read());
      });
    },
  };
});

const SR = 48000;
const FRAMES = 256 * 8; // a multiple of every tested quantum, so lengths match

test("renderOffline output is identical across render quanta for per-sample DSP", async () => {
  const input = new Float32Array(FRAMES).map((_, k) => (k % 97 < 48 ? 1 : -1));
  for (const processor of [sine, onePole]) {
    const reference = await renderOffline(processor, {
      sampleRate: SR,
      duration: FRAMES / SR,
      inputs: { main: [input] },
    });
    expect(reference.renderQuantumSize).toBe(128);
    for (const q of [32, 64, 256]) {
      const r = await renderOffline(processor, {
        sampleRate: SR,
        duration: FRAMES / SR,
        renderQuantumSize: q,
        inputs: { main: [input] },
      });
      expect(r.renderQuantumSize).toBe(q);
      expect(Array.from(r.outputs.main![0]!)).toEqual(Array.from(reference.outputs.main![0]!));
    }
  }
});

test("renderOffline rounds the duration up to whole quanta of the requested size", async () => {
  const length = async (renderQuantumSize?: number) =>
    (
      await renderOffline(sine, {
        sampleRate: SR,
        duration: 140 / SR,
        ...(renderQuantumSize === undefined ? {} : { renderQuantumSize }),
      })
    ).outputs.main![0]!.length;
  expect(await length()).toBe(256);
  expect(await length(32)).toBe(160);
  expect(await length(48)).toBe(144);
});

test("renderOffline delivers a MIDI event at its absolute sample whatever the quantum", async () => {
  // The note's sample position must not depend on how the render is cut into calls.
  const gate = defineProcessor(() => {
    const midi = event.midi({ from: "main", name: "in", capacity: 16 });
    const out = audioOutput({ channels: 1, name: "main" });
    const level = state.f32(0);
    const at = state.i32(-1);
    return {
      process: () => {
        // Handlers drain before the rest of process(), so `at` holds this call's
        // note offset (or -1) while the sample loop runs, and is cleared after it.
        midi.onEvent("noteOn", (e) => {
          at.write(e.atSample);
        });
        forSample((i) => {
          level.write(select(i.eq(at.read()), f32(1), level.read()));
          out.ch(0).at(i).write(level.read());
        });
        at.write(i32(-1));
      },
    };
  });
  const noteAt = 200;
  for (const q of [32, 128, 256]) {
    const r = await renderOffline(gate, {
      sampleRate: SR,
      duration: 512 / SR,
      renderQuantumSize: q,
      events: [
        {
          name: "in",
          atSample: noteAt,
          payload: { type: "noteOn", channel: 0, note: 60, velocity: 1 },
        },
      ],
    });
    const out = r.outputs.main![0]!;
    expect(out.indexOf(1)).toBe(noteAt);
  }
});
