/**
 * Browser e2e: a `?worklet` processor on an AudioContext whose sample rate or
 * render quantum differs from the build (48000 Hz, 128 samples). `createNode`
 * compiles it for the context in the processor's compile worker and loads the
 * result from a Blob URL, so the sound matches what the build plays at 48 kHz.
 */

import { expect, test } from "vite-plus/test";

import { createNode } from "../../index.ts";
import sine440 from "./fixtures/sine440.processor.ts?worklet";

type Rendered = { samples: Float32Array; renderQuantumSize: number; processorName: string };

async function render(sampleRate: number, renderSizeHint?: number): Promise<Rendered> {
  const context = new OfflineAudioContext({
    numberOfChannels: 1,
    length: Math.round(sampleRate / 2),
    sampleRate,
    ...(renderSizeHint === undefined ? {} : { renderSizeHint }),
  } as OfflineAudioContextOptions);
  const node = await createNode(context, sine440);
  node.outputs["main"]!.connect(context.destination);
  const buffer = await context.startRendering();
  const processorName = (node.node as unknown as { __processorName?: string }).__processorName;
  node.dispose();
  return {
    samples: buffer.getChannelData(0),
    renderQuantumSize:
      (context as unknown as { renderQuantumSize?: number }).renderQuantumSize ?? 128,
    processorName: processorName ?? "",
  };
}

/** Frequency from rising zero crossings over the whole render. */
function frequency(samples: Float32Array, sampleRate: number): number {
  let first = -1;
  let last = -1;
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1]! < 0 && samples[i]! >= 0) {
      if (first < 0) first = i;
      last = i;
      crossings++;
    }
  }
  return ((crossings - 1) * sampleRate) / (last - first);
}

test("the build's own rate plays 440 Hz without a compile worker (reference)", async () => {
  const rendered = await render(48_000);
  expect(frequency(rendered.samples, 48_000)).toBeCloseTo(440, 0);
});

test.each([44_100, 96_000])("a %i Hz context plays 440 Hz", async (sampleRate) => {
  const rendered = await render(sampleRate);
  expect(frequency(rendered.samples, sampleRate)).toBeCloseTo(440, 0);
  expect(Math.max(...rendered.samples)).toBeCloseTo(0.5, 2);
});

test.each([32, 64, 256])(
  "a context rendering %i-sample quanta plays the same samples as 128",
  async (hint) => {
    const reference = await render(48_000);
    const rendered = await render(48_000, hint);
    // Precondition: the engine honoured the hint (Chromium 153 does).
    expect(rendered.renderQuantumSize).toBe(hint);
    expect(Array.from(rendered.samples)).toEqual(Array.from(reference.samples));
  },
);
