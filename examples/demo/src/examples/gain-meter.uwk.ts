// gain-meter.uwk.ts — a gain knob + a 30 fps output level meter
const input = audioInput({ channels: 2, name: "main" });
const out   = audioOutput({ channels: 2, name: "main" });
const gain  = param.f32({ default: 0.8, min: 0, max: 2, automationRate: "a-rate" }).named();

// a transient state published to the main thread 30×/sec — drives a live meter
const level = state.f32(0).expose({ snapshot: "transient", publish: { rateFps: 30 } });

process(() => {
  forSample((i) => {
    const l = input.left[i] * gain[i];
    const r = input.right[i] * gain[i];
    out.left[i]  = l;
    out.right[i] = r;
    const mag = l < 0 ? -l : l;                 // |left|
    level.write(mag > level ? mag : level * 0.99); // peak-hold, slow decay
  });
});
