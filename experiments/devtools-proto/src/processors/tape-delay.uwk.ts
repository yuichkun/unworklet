// @ts-nocheck — sugar is a TS error until lowered; the plugin lowers it at build.
//
// RC-20-style Space / Magnetic (tape echo) — Tier-B `.uwk.ts`. Feedback ring-delay
// + decaying published peak meter. The persistent buffer and the published meter
// auto-derive their names from the binding via `.expose({...})`; the i64 counter
// keeps its `i64(1n)` increment. Index + operator + bare-state + free-function math.
const SAMPLE_RATE = 48000;
const DELAY = Math.round(SAMPLE_RATE * 0.3); // 300 ms tape head spacing
const SIZE = 32768; // ring length, > DELAY
const FEEDBACK = 0.45;
const WET = 0.5;
const METER_DECAY = 0.999;

const input = audioInput({ channels: 1, name: "main" });
const out = audioOutput({ channels: 1, name: "main" });

const delayLine = state.buffer.f32({ size: SIZE }).expose({ snapshot: "persistent" });
const head = state.i32(0).named();
// `feedback` + `mix` are knob params (defaults = the old fixed FEEDBACK / WET, so
// the offline render is unchanged); the UW-1 fbk / delay knobs write them live.
const feedback = param.f32({ default: FEEDBACK, min: 0, max: 0.95, automationRate: "a-rate" });
const mix = param.f32({ default: WET, min: 0, max: 1, automationRate: "a-rate" });
const sampleCount = state.i64(0n).named();
const meter = state.f32(0).expose({ publish: { rateFps: 30 } });

process(() => {
  forSample((i) => {
    const h = head.read();
    const delayed = delayLine[(h + (SIZE - DELAY)) % SIZE];
    const x = input.ch(0)[i];
    const wet = x + delayed * mix[i];
    out.ch(0)[i] = wet;

    // Feed input + feedback back into the line at the write head.
    delayLine[h] = x + delayed * feedback[i];

    // Decaying peak meter (published to main).
    meter.write(max(meter * METER_DECAY, abs(wet)));

    head.write((h + 1) % SIZE);
    sampleCount.write(sampleCount.read() + i64(1n));
  });
});
