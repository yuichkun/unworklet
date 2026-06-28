// @ts-nocheck — sugar; the plugin lowers it. A subgraph-only LIBRARY module (no
// process()): it exports a reusable one-pole low-pass for a processor to import.
export const onepole = defineSubgraph((coef: Node<"f32">) => {
  const z1 = state.f32(0).named("z1");
  return {
    tick: (x: Node<"f32">) => {
      const y = z1 + (x - z1) * coef; // y = z1 + (x - z1) * coef
      z1.write(y);
      return y;
    },
  };
});
