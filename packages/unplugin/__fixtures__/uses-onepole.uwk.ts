// @ts-nocheck — sugar; the plugin lowers it. A processor that imports a subgraph
// from a sibling .uwk.ts (onepole.uwk.ts) and instantiates it. The build must lower
// the imported library .uwk.ts too, or Node evaluates raw sugar and throws.
import { onepole } from "./onepole.uwk.ts";

const input = audioInput({ channels: 1, name: "main" });
const out = audioOutput({ channels: 1, name: "main" });
const lpf = instantiate(onepole, 0.2, { name: "lpf" });

process(() => {
  forSample((i) => {
    out.ch(0)[i] = lpf.tick(input.ch(0)[i]);
  });
});
