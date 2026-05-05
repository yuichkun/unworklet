// @unworklet/dsp/precise — high-precision math variants (per spec docs §12.4).
//
// The default math primitives in @unworklet/core (sin/cos/tan/exp/log) compile
// to JS-imported Math.* in the WASM module. The "precise" variants here are
// the same — JS Math.* IS the high-precision implementation. The "/precise"
// import path exists per spec to make the choice explicit at the call site.

export { sin, cos, tan, tanh, exp, log, sqrt } from "@unworklet/core";
