/**
 * typed-array messaging の element-型 surface contract (= 案A: 型を実装に合わせる)。
 *
 * message / event の可変長 typed-array field の element 型 (f32 / u8) は TS の型 T に
 * しか無く実行時に消える。実装は proxy で f32 を扱うので、型 surface も「直接読み
 * (.at / .length) は f32 専用、byte (u8) 等は buffer.<T> + copyFrom 経由」に揃える。
 *
 * ここは public 型 (MessageGraphPayload / EmitPayload / TypedArrayFieldRef) に対する
 * 型レベル黒箱契約 + emit 側の fail-loud guard を検証する。
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

// ── 型レベル契約 (= `vp check` の typecheck が検証、実行時 no-op) ────────────
// 制約 (`T extends true/false`) を満たさない型が来ると call site で型エラー = RED。
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

test("typed-array surface: element 型契約は vp check の typecheck で検証される", () => {
  // f32 typed-array field は直接読み (.at / .length) を持つ。
  expectTrue<Has<"at", F32Field>>();
  expectTrue<Has<"length", F32Field>>();
  // u8 typed-array field は copyFrom 専用 = 直接読みを持たない。
  expectFalse<Has<"at", U8Field>>();
  expectFalse<Has<"length", U8Field>>();
  // copyFrom には element 型一致で渡せる (= Q31-c の element-type compatibility)。
  expectTrue<AssignableTo<U8Field, Parameters<BufferHandle<"u8">["copyFrom"]>[0]>>();
  expectTrue<AssignableTo<F32Field, Parameters<BufferHandle<"f32">["copyFrom"]>[0]>>();
  // emit 側の typed-array field は Buffer<T> のみ = inbound proxy (TypedArrayFieldRef) は
  // 直接渡せない (= re-emit は copyFrom→buffer 経由)。
  expectTrue<AssignableTo<BufferHandle<"f32">, EmitData>>();
  expectFalse<AssignableTo<TypedArrayFieldRef<"f32">, EmitData>>();
  // scalar message field は handler 側で Node に lift される (= Q46)。raw JS 値の
  // まま漏らすと slot + 1 / if(armed) が capture 時 proxy に対して走って壊れる。
  expectTrue<AssignableTo<SlotField, Node<"i32">>>();
  expectFalse<AssignableTo<SlotField, number>>();
  expectTrue<AssignableTo<ArmedField, Node<"bool">>>();
  expectFalse<AssignableTo<ArmedField, boolean>>();
  expect(true).toBe(true);
});

// ── 案A の置き換えパス: byte (u8) は buffer.u8 + copyFrom で動く ──────────────

test("u8 byte payload は buffer.u8 + copyFrom 経由で compile を通る (= 案A の置き換えパス)", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const up = event<{ bytes: Uint8Array }>({ from: "main", name: "sysexIn" });
    const buf = state.buffer.u8({ size: 16 });
    return {
      process: () => {
        up.onReceive(({ bytes }) => {
          buf.copyFrom(bytes); // u8 element 型で seal + memory.copy
        });
        // buf.read(i) は Node<'i32'> (= zero-extended byte)、f32 に変換して出力。
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
