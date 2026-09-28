// limiter.uwk.ts — a lookahead limiter that fires an overshoot event
const input   = audioInput({ channels: 1, name: "main" });
const out     = audioOutput({ channels: 1, name: "main" });
const ceiling = param.f32({ default: 0.5, min: 0.05, max: 1, automationRate: "a-rate" }).named();

const dly  = state.buffer.f32({ size: 64 }).named("dly"); // lookahead delay line
const head = state.i32(0).named("head");
const env  = state.f32(0).named("env");
// a typed event back to the main thread, fired sample-accurately on an overshoot
const overshoot = event({ to: "main", name: "overshoot" });

process(() => {
  forSample((i) => {
    const x = input.ch(0)[i];
    const mag = x < 0 ? -x : x;
    env.write(mag > env ? mag : env * 0.9995);      // fast attack, slow release
    const w = head;                                  // current write head (i32)
    dly[w] = x;                                       // delay-line write
    const delayed = dly[(w + 1) % 64];                // read the oldest sample
    const g = env > ceiling[i] ? ceiling[i] / env : 1; // gain reduction
    out.ch(0)[i] = delayed * g;
    head.write((w + 1) % 64);
    overshoot.emitIf(mag > ceiling[i], { atSample: i, level: mag });
  });
});
