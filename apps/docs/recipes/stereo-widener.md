<script setup>
const tryItCode0 = `import {
  defineProcessor, audioInput, audioOutput, param, forSample,
  add, sub, mul,
} from "@unworklet/core";

export const widener = defineProcessor(() => {
  const main = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });
  const width = param({
    name: "width", default: 1.5, min: 0, max: 3, automationRate: "a-rate",
  });

  return {
    process: () => {
      forSample((i) => {
        const L = main.left.at(i);
        const R = main.right.at(i);
        // Mid/Side encode (no √2 normalization — that gets folded into output).
        const M = mul(add(L, R), 0.5);
        const S = mul(sub(L, R), 0.5);
        // Scale side.
        const Sw = mul(S, width.at(i));
        // Decode.
        out.left.set(i,  add(M, Sw));
        out.right.set(i, sub(M, Sw));
      });
    },
  };
});
`;
</script>

# Stereo widener (Mid/Side)

Decompose into Mid (L+R)/2 and Side (L-R)/2, scale Side, recompose. Sub-quadratic-cost classic mastering tool.

<TryIt label="M/S widener" :code="tryItCode0" />

`width = 0` collapses to mono. `width = 1` leaves the input unchanged. `width > 1` widens; you'll start to hear phase weirdness above ~2 (because Side is amplified relative to Mid).

::: tip Branchless guarantees
The DSL doesn't have JS `?:` for graph nodes. `select(cond, a, b)` is the branchless equivalent. Used inside `forSample` it lowers to a single WASM `select` instruction — no jump, no JIT deopt risk.
:::
