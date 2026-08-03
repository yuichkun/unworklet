/**
 * Element-type surface contract for typed-array messaging (approach A: align types with implementation).
 *
 * The element type (f32 / u8) of variable-length typed-array fields in messages/events
 * exists only in the TS type T and is erased at runtime. Because the implementation
 * handles f32 via proxy, the type surface follows the same rule: direct reads
 * (.at / .length) are f32-only; byte (u8) access goes through buffer.<T> + copyFrom.
 *
 * This file verifies the type-level black-box contract for public types
 * (MessageGraphPayload / EmitPayload / TypedArrayFieldRef) and the fail-loud guard
 * on the emit side.
 */

import { expect, test } from "vite-plus/test";

import "../../dsl/primitives.ts";
import { compile } from "../../compile/index.ts";
import { f32 } from "../../dsl/constructors.ts";
import { event, audioOutput, state } from "../../dsl/declarations.ts";
import { forSample } from "../../dsl/loop.ts";
import { defineProcessor } from "../../processor.ts";
import type {
  Buffer as BufferHandle,
  EmitPayload,
  MessageGraphPayload,
  Node,
  TypedArrayFieldRef,
} from "../../types.ts";

// ── Type-level contract (verified by `vp check` typecheck; runtime no-op) ───────────
// A type that fails the constraint (`T extends true/false`) produces a type error at the call site = RED.
type Has<K extends string, T> = K extends keyof T ? true : false;
type AssignableTo<A, B> = A extends B ? true : false;
function expectTrue<_T extends true>(): void {}
function expectFalse<_T extends false>(): void {}

type F32Field = MessageGraphPayload<{ samples: Float32Array }>["samples"];
type U8Field = MessageGraphPayload<{ bytes: Uint8Array }>["bytes"];
type EmitData = EmitPayload<{ data: Float32Array }>["data"];
type ScalarPayload = MessageGraphPayload<{ slot: number; armed: boolean }>;
type SlotField = ScalarPayload["slot"];
type ArmedField = ScalarPayload["armed"];

test("typed-array surface: element-type contract is verified by vp check typecheck", () => {
  // f32 typed-array fields expose direct reads (.at / .length).
  expectTrue<Has<"at", F32Field>>();
  expectTrue<Has<"length", F32Field>>();
  // u8 typed-array fields are copyFrom-only = no direct reads.
  expectFalse<Has<"at", U8Field>>();
  expectFalse<Has<"length", U8Field>>();
  // copyFrom accepts a matching element type (element-type compatibility).
  expectTrue<AssignableTo<U8Field, Parameters<BufferHandle<"u8">["copyFrom"]>[0]>>();
  expectTrue<AssignableTo<F32Field, Parameters<BufferHandle<"f32">["copyFrom"]>[0]>>();
  // The emit-side typed-array field accepts only Buffer<T>; the inbound proxy
  // (TypedArrayFieldRef) is not directly assignable — re-emit must go through copyFrom→buffer.
  expectTrue<AssignableTo<BufferHandle<"f32">, EmitData>>();
  expectFalse<AssignableTo<TypedArrayFieldRef<"f32">, EmitData>>();
  // Scalar message fields are lifted to Node on the handler side. Leaking them as raw
  // JS values would cause slot + 1 / if(armed) to run against a proxy at capture time
  // and corrupt the graph.
  expectTrue<AssignableTo<SlotField, Node<"f32">>>();
  expectFalse<AssignableTo<SlotField, number>>();
  expectTrue<AssignableTo<ArmedField, Node<"bool">>>();
  expectFalse<AssignableTo<ArmedField, boolean>>();
  expect(true).toBe(true);
});

// ── Approach A replacement path: byte (u8) access works via buffer.u8 + copyFrom ───────

test("u8 byte payload compiles successfully via buffer.u8 + copyFrom (approach A replacement path)", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const up = event<{ bytes: Uint8Array }>({ from: "main", name: "sysexIn" });
    const buf = state.buffer.u8({ size: 16 });
    return {
      process: () => {
        up.onReceive(({ bytes }) => {
          buf.copyFrom(bytes); // seals with u8 element type + memory.copy
        });
        // buf.read(i) returns Node<'i32'> (zero-extended byte); convert to f32 for output.
        forSample((i) => {
          out
            .ch(0)
            .at(i)
            .write(f32(buf.read(i)));
        });
      },
    };
  });
  const result = await compile(proc);
  expect(result.wasm.byteLength).toBeGreaterThan(0);
});
