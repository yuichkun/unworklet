// @unworklet/dsp/table — table-based math approximations (per spec Q17).
//
// Trades ~22-bit accuracy for 3-5× faster sin/cos/exp/log on hot paths.
// The WASM emitter recognizes the `precision: "table"` tag set on these
// primitives and lowers them to a 4096-entry quarter-wave / piecewise-linear
// lookup table embedded at the end of linear memory at compile time.
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
