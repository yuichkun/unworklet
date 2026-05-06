// @unworklet/dsp/precise — high-precision math variants (per spec Q17).
//
// Re-exports the precision-tagged primitives from @unworklet/core. These
// dispatch through the capture backend's `*Precise` hooks; in the default
// WASM emitter, "precise" maps to the same JS-imported Math.* path as
// `default` (which is already f64-accurate via the math import), but the
// import-path distinction is preserved so future codegen can substitute
// a higher-precision lowering without churning user call sites.

export {
  sinPrecise as sin,
  cosPrecise as cos,
  tanPrecise as tan,
  tanhPrecise as tanh,
  expPrecise as exp,
  logPrecise as log,
  sqrt,
} from "@unworklet/core";
