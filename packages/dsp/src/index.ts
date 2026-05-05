// @unworklet/dsp — primitive operators (re-exported from @unworklet/core).
//
// Per draft_spec §3.2 / §5.2 the primitive operator surface lives in this
// package. The canonical examples in docs/12 import everything from
// @unworklet/core directly; @unworklet/dsp is a stable alias for code that
// prefers the spec's split surface.

export {
  // Arithmetic
  add,
  sub,
  mul,
  div,
  mod,
  neg,
  // Comparison
  eq,
  ne,
  lt,
  gt,
  lte,
  gte,
  // Math (default precision)
  sin,
  cos,
  tan,
  tanh,
  exp,
  log,
  sqrt,
  abs,
  floor,
  ceil,
  frac,
  min,
  max,
  clamp,
  // Control
  select,
  // Type conversion
  f32,
  f64,
  i32,
  i64,
} from "@unworklet/core";
