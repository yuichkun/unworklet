// reverb.uwk.ts — a small feedback reverb (4 comb filters + 1 allpass)
const input = audioInput({ channels: 1, name: "main" });
const out   = audioOutput({ channels: 1, name: "main" });
const mix   = param.f32({ default: 0.5, min: 0, max: 1 }).named();

// four parallel feedback combs, prime-ish delay lengths (Schroeder/Freeverb-style)
const c0 = state.buffer.f32({ size: 1116 }).named("c0");
const c1 = state.buffer.f32({ size: 1188 }).named("c1");
const c2 = state.buffer.f32({ size: 1277 }).named("c2");
const c3 = state.buffer.f32({ size: 1356 }).named("c3");
const h0 = state.i32(0).named("h0");
const h1 = state.i32(0).named("h1");
const h2 = state.i32(0).named("h2");
const h3 = state.i32(0).named("h3");
const a0 = state.buffer.f32({ size: 556 }).named("a0"); // allpass diffuser
const ah = state.i32(0).named("ah");

process(() => {
  forSample((i) => {
    const x = input.ch(0)[i];
    const w0 = h0; const r0 = c0[w0]; c0[w0] = x + r0 * 0.7; h0.write((w0 + 1) % 1116);
    const w1 = h1; const r1 = c1[w1]; c1[w1] = x + r1 * 0.7; h1.write((w1 + 1) % 1188);
    const w2 = h2; const r2 = c2[w2]; c2[w2] = x + r2 * 0.7; h2.write((w2 + 1) % 1277);
    const w3 = h3; const r3 = c3[w3]; c3[w3] = x + r3 * 0.7; h3.write((w3 + 1) % 1356);
    const combs = (r0 + r1 + r2 + r3) * 0.25;
    const wa = ah; const da = a0[wa];
    const apOut = -0.5 * combs + da;
    a0[wa] = combs + 0.5 * apOut;
    ah.write((wa + 1) % 556);
    out.ch(0)[i] = (1 - mix[i]) * x + mix[i] * apOut; // dry / wet
  });
});
