import assert from "node:assert/strict";
import os from "node:os";
import { chromium } from "playwright";

// Characterization only: successful execution does not assert zero stale samples.
const browser = await chromium.launch({ headless: true });
try {
  const session = await browser.newBrowserCDPSession();
  console.log(
    "NATIVE_BOUNDARY_ENV " +
      JSON.stringify({
        browser: browser.version(),
        platform: os.platform(),
        release: os.release(),
        architecture: os.arch(),
        flags: (await session.send("Browser.getBrowserCommandLine")).arguments,
      }),
  );
  assert.equal(browser.version(), "148.0.7778.96", "Diagnostic requires pinned CI Chromium");
  const page = await browser.newPage();
  const cases = [
    {
      label: "exact-original-recipe",
      sampleRate: 48000,
      frame: 57728,
      automationRate: "default",
      initialization: "value",
      mutation: "value",
    },
  ];
  for (const sampleRate of [48000, 16384]) {
    for (const frame of [57600, 57728, 57856]) {
      for (const automationRate of ["a-rate", "k-rate"]) {
        for (const initialization of ["constructor", "value", "scheduled"]) {
          for (const mutation of ["value", "scheduled"]) {
            cases.push({
              label: "matrix",
              sampleRate,
              frame,
              automationRate,
              initialization,
              mutation,
            });
          }
        }
      }
    }
  }
  for (const specification of cases) {
    const result = await page.evaluate(async (spec) => {
      const { sampleRate, frame, initialization, mutation, automationRate } = spec;
      const context = new OfflineAudioContext(1, frame + 256, sampleRate);
      const source = new ConstantSourceNode(context, {
        offset: initialization === "constructor" ? 0 : 1,
      });
      if (automationRate !== "default") source.offset.automationRate = automationRate;
      if (initialization === "value") source.offset.value = 0;
      if (initialization === "scheduled") source.offset.setValueAtTime(0, 0);
      source.connect(context.destination);
      source.start();
      const requestedPauseTime = frame / sampleRate;
      const suspended = context.suspend(requestedPauseTime);
      const rendering = context.startRendering();
      await suspended;
      const pausedTime = context.currentTime;
      const valueBefore = source.offset.value;
      if (mutation === "value") source.offset.value = 1;
      else source.offset.setValueAtTime(1, pausedTime);
      const valueAfter = source.offset.value;
      await context.resume();
      const output = (await rendering).getChannelData(0);
      const resumed = Array.from(output.slice(frame, frame + 256));
      return {
        ...spec,
        actualAutomationRate: source.offset.automationRate,
        requestedPauseTime,
        pausedTime,
        pausedTimeProduct: pausedTime * sampleRate,
        valueBefore,
        valueAfter,
        outputLength: output.length,
        firstResumedSamples: resumed.slice(0, 8),
        leadingStaleSamples: resumed.findIndex((value) => value === 1),
        beforeBlock: Array.from(output.slice(frame - 128, frame)),
        resumedBlocks: resumed,
      };
    }, specification);
    console.log("NATIVE_BOUNDARY_MEASUREMENT " + JSON.stringify(result));
    assert.equal(result.outputLength, specification.frame + 256);
    assert.equal(result.beforeBlock.length, 128);
    assert.equal(result.resumedBlocks.length, 256);
    assert.ok(result.beforeBlock.every((value) => value === 0));
    assert.ok(result.resumedBlocks.every((value) => Number.isFinite(value)));
    assert.equal(result.resumedBlocks.at(-1), 1);
    if (specification.automationRate !== "default") {
      assert.equal(result.actualAutomationRate, specification.automationRate);
    }
  }
  console.log("NATIVE_BOUNDARY_COMPLETE " + JSON.stringify({ cases: cases.length }));
} finally {
  await browser.close();
}
