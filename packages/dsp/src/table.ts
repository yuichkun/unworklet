// @unworklet/dsp/table — table-based math approximations (per spec Q17).
//
// Trades ~22-bit accuracy for 3-5× faster sin/cos/exp/log on hot paths.
// The WASM emitter recognizes the `precision: "table"` tag set on these
// primitives and lowers them to a 4096-entry quarter-wave / piecewise-linear
// lookup table embedded at the end of linear memory at compile time.
//
// `tan`/`tanh` are NOT exposed here because (a) `tan` has poles every π/2
// that ruin a uniform interpolation table and (b) `tanh` saturates outside
// ±5 — both want a custom approximation rather than a generic table. Use
// the default precision (which compiles to the JS Math import) for those.
//
// In interpret mode (Node tests, OfflineRender JS path) these still
// dispatch to JS Math.* — the table approximation is only observable in
// the compiled WASM output.

export {
  sinTable as sin,
  cosTable as cos,
  expTable as exp,
  logTable as log,
} from "@unworklet/core";
