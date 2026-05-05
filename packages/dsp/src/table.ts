// @unworklet/dsp/table — table-based math approximations (per spec §12.4).
//
// Trades a small amount of accuracy for ~3-5× faster execution by reading
// from a precomputed lookup table instead of calling Math.*. In WASM, the
// table is stored in linear memory at compile time and reads are bounds-
// safe modulo the table length.
//
// For v0.1 these import paths exist as alias entries; a full table-backed
// codegen path is queued behind the open Q17 in docs/decisions-log.md
// (math-precision import-path decision). Until then, these alias to the
// default precision implementations so user code that imports from
// @unworklet/dsp/table compiles correctly.

export { sin, cos, exp, log } from "@unworklet/core";
