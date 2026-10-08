import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { expect, test } from "vite-plus/test";

test("Signals analyser measures the mono downmix without changing the stereo output", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("const ensureAnalysers =");
  const end = source.indexOf("let signalsBusy =", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addScriptTag({
      content: `const analysersByNode = new Map();
const realConnect = AudioNode.prototype.connect;
${source.slice(start, end)}
globalThis.ensureSignalsAnalysers = ensureAnalysers;`,
    });
    const results = await page.evaluate(`(async () => {
      const ensure = globalThis.ensureSignalsAnalysers;
      const cases = [
        { name: "mono", samples: [0.5] },
        { name: "same-phase stereo", samples: [0.5, 0.5] },
        { name: "opposite-phase stereo", samples: [0.5, -0.5] },
        { name: "single-channel stereo", samples: [0.5, 0] },
      ];
      const results = [];
      for (const { name, samples } of cases) {
        const context = new OfflineAudioContext(2, 4096, 48000);
        const buffer = context.createBuffer(samples.length, 4096, 48000);
        samples.forEach((sample, channel) => buffer.getChannelData(channel).fill(sample));
        const node = context.createBufferSource();
        node.buffer = buffer;
        node.connect(context.destination);
        const tap = ensure(node, { audio: {} }).get("audio");
        const mute = context.createGain();
        mute.gain.value = 0;
        tap.analyser.connect(mute).connect(context.destination);
        node.start();
        const rendered = await context.startRendering();
        tap.analyser.getFloatTimeDomainData(tap.time);
        const peak = Math.max(...tap.time.map(Math.abs));
        const rms = Math.sqrt(
          tap.time.reduce((sum, sample) => sum + sample * sample, 0) / tap.time.length,
        );
        results.push({
          name,
          left: rendered.getChannelData(0)[2048],
          right: rendered.getChannelData(1)[2048],
          peak,
          rms,
        });
      }
      return results;
    })()`);
    expect(results).toEqual([
      { name: "mono", left: 0.5, right: 0.5, peak: 0.5, rms: 0.5 },
      { name: "same-phase stereo", left: 0.5, right: 0.5, peak: 0.5, rms: 0.5 },
      { name: "opposite-phase stereo", left: 0.5, right: -0.5, peak: 0, rms: 0 },
      { name: "single-channel stereo", left: 0.5, right: 0, peak: 0.25, rms: 0.25 },
    ]);
  } finally {
    await browser.close();
  }
});
