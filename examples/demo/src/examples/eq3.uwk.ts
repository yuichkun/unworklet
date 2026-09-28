// eq3.uwk.ts — a 3-band tone control (low / mid / high)
const input = audioInput({ channels: 2, name: "main" });
const out   = audioOutput({ channels: 2, name: "main" });
const low   = param.f32({ default: 1, min: 0, max: 2 }).named();
const mid   = param.f32({ default: 1, min: 0, max: 2 }).named();
const high  = param.f32({ default: 1, min: 0, max: 2 }).named();

// one-pole lowpass: k·x + (1-k)·$prev  ($prev = the previous output)
const lp = defineSubgraph((k: Node<"f32">) => ({
  process: (x: Node<"f32">) => k * x + (1 - k) * $prev,
}));
const loL = instantiate(lp, f32(0.08), { name: "loL" }); // low band
const loR = instantiate(lp, f32(0.08), { name: "loR" });
const hiL = instantiate(lp, f32(0.5), { name: "hiL" });  // low+mid split
const hiR = instantiate(lp, f32(0.5), { name: "hiR" });

process(() => {
  forSample((i) => {
    const xL = input.left[i];
    const bassL = loL.process(xL);
    const splitL = hiL.process(xL);
    // low + mid + high, each scaled; at unity gains the three bands sum back to x
    out.left[i] = bassL * low[i] + (splitL - bassL) * mid[i] + (xL - splitL) * high[i];
    const xR = input.right[i];
    const bassR = loR.process(xR);
    const splitR = hiR.process(xR);
    out.right[i] = bassR * low[i] + (splitR - bassR) * mid[i] + (xR - splitR) * high[i];
  });
});
