# @unworklet/core/simd

Opt-in SIMD. v1.0.0 ships f32x4 only.

```ts
import { vec4, splat, addVec, subVec, mulVec, divVec } from "@unworklet/core/simd";

splat(x: Node<'f32'> | number): Node<'f32x4'>
vec4(a, b, c, d): Node<'f32x4'>
addVec(a, b): Node<'f32x4'>
subVec(a, b): Node<'f32x4'>
mulVec(a, b): Node<'f32x4'>
divVec(a, b): Node<'f32x4'>
// On the returned vector:
v.lane(0|1|2|3): Node<'f32'>
```

## Buffer SIMD

`buffer.f32` exposes:

```ts
buf.loadVec(offset: Node<'i32'> | number): Node<'f32x4'>
buf.storeVec(offset: Node<'i32'> | number, v: Node<'f32x4'>): void
```

See [SIMD guide](/guide/simd) for examples and benchmark numbers.
