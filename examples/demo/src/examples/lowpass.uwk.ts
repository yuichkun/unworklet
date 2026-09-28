// lowpass.uwk.ts — a one-pole lowpass (per channel)
const input  = audioInput({ channels: 2, name: "main" });
const out    = audioOutput({ channels: 2, name: "main" });
const cutoff = param.f32({ default: 0.2, min: 0.01, max: 1 }).named();

// y[n] = k*x[n] + (1-k)*y[n-1]   ($prev = previous output)
const onepole = defineSubgraph((k: Node<"f32">) => ({
  process: (x: Node<"f32">) => k * x + (1 - k) * $prev,
}));
const lpL = instantiate(onepole, f32(0.2), { name: "lpL" });
const lpR = instantiate(onepole, f32(0.2), { name: "lpR" });

process(() => {
  forSample((i) => {
    out.left[i]  = lpL.process(input.left[i]);
    out.right[i] = lpR.process(input.right[i]);
  });
});
