# 01 — DSL (`@unworklet/core` + `@unworklet/dsp`)

The surface the user authors against. Defines `defineProcessor`, primitives, declarations (`state`, `buffer`, `param`), and authoring patterns for reusable DSP blocks.

## Status

skeleton

## 1. `defineProcessor` and I/O declarations

<!-- defineProcessor(config) shape, audioInput / audioOutput, `inputs` and `outputs` records.
     Q5 (multi-output processors) — explicit support, schema rules. Lands here. -->

## 2. Primitive operators

<!-- Full inventory: arithmetic (add/sub/mul/div/mod/neg), comparison (eq/lt/gt/lte/gte),
     math (sin/cos/tan/tanh/exp/log/sqrt/abs/floor/ceil/frac/min/max/clamp),
     control (select), memory (load/store/readBuffer/writeBuffer/readBufferInterpolated),
     type conversions (f32/f64/i32/i64).
     Q14 (math precision: default vs `/precise` vs `/table` import paths). Lands here. -->

## 3. State, buffer, param declarations

<!-- state.f32 / state.f64 / state.i32 / state.i64 / state.bool: load() / store(node);
     buffer.* with size + name; access via readBuffer / writeBuffer / readBufferInterpolated;
     param({ default, min, max, automationRate, unit? }): .at(i) access. -->

## 4. Messages and events declarations

<!-- message({...}) and event({...}) declaration shape (the runtime contract lives in 02-messaging.md;
     this section only covers DSL surface — how the user *declares* them). -->

## 5. Authoring patterns

<!-- Q2 (user-defined macros) — how reusable DSP blocks (biquad, adsr, onepole, ...) are written.
     Per-callsite state allocation rules, no JS control flow over Node values, etc. Lands here. -->

## 6. The two phases

<!-- `process(({ inputs, outputs, params, ctx })) => sample => ...` shape;
     `publish(({ state, emit, every }))` shape;
     scheduling and constraints of each. -->
