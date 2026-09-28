// linear-phase.uwk.ts — a symmetric (linear-phase) FIR lowpass
const input = audioInput({ channels: 1, name: "main" });
const out   = audioOutput({ channels: 1, name: "main" });

// 9-tap triangular kernel [1,2,3,4,5,4,3,2,1]/25. Symmetric taps (c_k = c_{8-k})
// are exactly what make the filter linear phase. A ring buffer holds the last 9
// samples; the output is the kernel convolved with that window (scalar FIR).
const z    = state.buffer.f32({ size: 9 }).named("z");
const head = state.i32(0).named("head");

process(() => {
  forSample((i) => {
    const w = head;
    z[w] = input.ch(0)[i];                  // newest sample x[n]
    const x0 = z[w];
    const x1 = z[(w + 8) % 9];
    const x2 = z[(w + 7) % 9];
    const x3 = z[(w + 6) % 9];
    const x4 = z[(w + 5) % 9];
    const x5 = z[(w + 4) % 9];
    const x6 = z[(w + 3) % 9];
    const x7 = z[(w + 2) % 9];
    const x8 = z[(w + 1) % 9];
    out.ch(0)[i] =
      (x0 * 1 + x8 * 1 + x1 * 2 + x7 * 2 + x2 * 3 + x6 * 3 + x3 * 4 + x5 * 4 + x4 * 5) / 25;
    head.write((w + 1) % 9);
  });
});
