// Type declarations injected into the Monaco editor for gen~ snippets.
// Exposes the unworklet DSL surface (chain methods, state, buffer, num,
// select, flushDenormals) plus the gen~-specific bindings (in1..in4) and
// expected return shape (Node<'f32'>[]).

export const GEN_DTS = String.raw`
declare type ScalarType = 'f32' | 'f64' | 'i32' | 'i64' | 'bool';
declare interface Node<T extends ScalarType> {
  add(b: Node<T> | number): Node<T>;
  sub(b: Node<T> | number): Node<T>;
  mul(b: Node<T> | number): Node<T>;
  div(b: Node<T> | number): Node<T>;
  mod(b: Node<T> | number): Node<T>;
  neg(): Node<T>;
  abs(): Node<T>;
  min(b: Node<T> | number): Node<T>;
  max(b: Node<T> | number): Node<T>;
  clamp(lo: Node<T> | number, hi: Node<T> | number): Node<T>;
  eq(b: Node<T> | number): Node<'bool'>;
  ne(b: Node<T> | number): Node<'bool'>;
  lt(b: Node<T> | number): Node<'bool'>;
  gt(b: Node<T> | number): Node<'bool'>;
  lte(b: Node<T> | number): Node<'bool'>;
  gte(b: Node<T> | number): Node<'bool'>;
  toF32(): Node<'f32'>;
  toI32(): Node<'i32'>;
  // float math
  sin(): Node<T>;
  cos(): Node<T>;
  tan(): Node<T>;
  tanh(): Node<T>;
  exp(): Node<T>;
  log(): Node<T>;
  sqrt(): Node<T>;
  pow(b: Node<T> | number): Node<T>;
  floor(): Node<T>;
  ceil(): Node<T>;
  round(): Node<T>;
  sign(): Node<T>;
}

declare interface StateHandle<T extends ScalarType> {
  load(): Node<T>;
  store(v: Node<T> | number): void;
}
declare interface BufferHandle<T extends ScalarType> {
  read(idx: Node<'i32'> | number): Node<T>;
  write(idx: Node<'i32'> | number, v: Node<T> | number): void;
}

// gen~ runtime bindings — these are injected into the Function() scope
// at compile time. You don't need to import anything.
declare const in1: Node<'f32'>;
declare const in2: Node<'f32'>;
declare const in3: Node<'f32'>;
declare const in4: Node<'f32'>;

declare const state: {
  f32: (initial: number, opts?: { name?: string; publish?: { rateFps: number } }) => StateHandle<'f32'>;
  i32: (initial: number, opts?: { name?: string }) => StateHandle<'i32'>;
  bool: (initial: boolean, opts?: { name?: string }) => StateHandle<'bool'>;
};

declare const buffer: {
  f32: (opts: { size: number; name?: string; publish?: { rateFps: number } }) => BufferHandle<'f32'>;
};

declare function num(v: number): Node<'f32'>;
declare function select<T extends ScalarType>(cond: Node<'bool'> | boolean, a: Node<T> | number, b: Node<T> | number): Node<T>;
declare function flushDenormals(x: Node<'f32'>): Node<'f32'>;

// gen~ snippets must end with a return that returns an array of Node<'f32'>
// — one per declared outlet. The first outlet is your audio output by
// convention; additional outlets correspond to outletCount in the gen~ attrs.
//
// Example: a sine oscillator that takes freq on in1
//   const sr = 48000;
//   const phase = state.f32(0);
//   const inc = in1.div(sr);
//   const next = phase.load().add(inc).mod(1);
//   phase.store(next);
//   return [next.mul(2 * Math.PI).sin()];
`;
