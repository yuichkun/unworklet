// @ts-nocheck — sugar; the plugin lowers it. The INLINE equivalent of
// uses-onepole.uwk.ts: the same one-pole subgraph defined in the same file as the
// processor (not imported from a sibling). Splitting the subgraph into its own file
// must not change the compiled graph, so this and uses-onepole.uwk.ts emit
// byte-identical WASM.
const onepole = defineSubgraph((coef: Node<"f32">) => {
  const z1 = state.f32(0).named("z1");
  return {
    tick: (x: Node<"f32">) => {
      const y = z1 + (x - z1) * coef;
      z1.write(y);
      return y;
    },
  };
});

const input = audioInput({ channels: 1, name: "main" });
const out = audioOutput({ channels: 1, name: "main" });
const lpf = instantiate(onepole, 0.2, { name: "lpf" });

process(() => {
  forSample((i) => {
    out.ch(0)[i] = lpf.tick(input.ch(0)[i]);
  });
});
