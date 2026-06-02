/**
 * Compile-pipeline coverage for typed-array message payloads (Stage 2.5a).
 *
 * End-to-end behavior (reading a received array via at/length) is covered by
 * renderOffline black-box tests in `@unworklet/offline`, because the driver
 * has no message-injection capability. These tests verify that the
 * proxy (capture) + payloadContent layout + payloadField emit pipeline
 * compiles successfully and that the layout reserves a content region.
 */

import { expect, test } from "vite-plus/test";

import "../../dsl/primitives.ts"; // side-effect: register `Node<T>` method forms
import { audioOutput, event, state } from "../../dsl/declarations.ts";
import { f32, i32 } from "../../dsl/constructors.ts";
import { forSample } from "../../dsl/loop.ts";
import { compile } from "../../compile/index.ts";
import { defineProcessor } from "../../processor.ts";

test("typed-array message compiles: proxy + payloadContent layout + payloadField emit", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const upload = event<{ samples: Float32Array }>({ from: "main", name: "upload" });
    const buf = state.buffer.f32({ size: 8 });
    const lenState = state.named("len").i32(0);
    return {
      process: () => {
        upload.onReceive(({ samples }) => {
          lenState.write(samples.length); // payloadFieldLength
          forSample((i) => {
            buf.write(i, samples.at(i)); // payloadFieldRead (runtime indexed)
          });
        });
        forSample((i) => {
          out.ch(0).at(i).write(buf.read(i));
        });
      },
    };
  });

  const result = await compile(proc);
  expect(result.wasm.byteLength).toBeGreaterThan(0);

  // A typed-array message must have a payloadContent region allocated.
  const memory = result.memory as unknown as {
    regions: {
      payloadContent: {
        eventSlots: Record<string, { base: number; capacity: number }>;
        messageSlots: Record<string, { base: number; capacity: number }>;
      };
    };
  };
  const content = memory.regions.payloadContent.messageSlots["upload"];
  expect(content).toBeDefined();
  expect(content!.capacity).toBeGreaterThan(0);
});

test("typed-array message compiles: buf.copyFrom(payload) bulk-copy emit path", async () => {
  // End-to-end behavior (copied value equality / clamping) is covered by
  // `@unworklet/offline` black-box tests. This test verifies that the
  // copyFrom proxy meta + bufferCopyFrom emit (= memory.copy) path
  // compiles successfully within core.
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const upload = event<{ samples: Float32Array }>({ from: "main", name: "upload" });
    const buf = state.buffer.f32({ size: 8 });
    return {
      process: () => {
        upload.onReceive(({ samples }) => {
          buf.copyFrom(samples); // bufferCopyFrom (= memory.copy)
        });
        forSample((i) => {
          out.ch(0).at(i).write(buf.read(i));
        });
      },
    };
  });

  const result = await compile(proc);
  expect(result.wasm.byteLength).toBeGreaterThan(0);
  const memory = result.memory as unknown as {
    regions: {
      payloadContent: {
        eventSlots: Record<string, { base: number; capacity: number }>;
        messageSlots: Record<string, { base: number; capacity: number }>;
      };
    };
  };
  expect(memory.regions.payloadContent.messageSlots["upload"]).toBeDefined();
});

test("typed-array event compiles: emitIf(buffer + length) emit path + payloadContent", async () => {
  // End-to-end behavior (received array value equality) is covered by the
  // `@unworklet/offline` black-box tests. This test verifies that
  // emitIf buffer detection + event payloadContent layout + emitEventEmitIf
  // (= memory.copy) compile successfully and that a content region is
  // allocated for the event within core.
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const buf = state.buffer.f32({ size: 4 });
    const result = event<{ data: Float32Array }>({
      to: "main",
      name: "result",
      payloadCapacity: 64,
    });
    return {
      process: () => {
        buf.write(0, f32(1));
        result.emitIf(true, { atSample: 0, data: buf, length: i32(4) });
        forSample((i) => {
          out.ch(0).at(i).write(f32(0));
        });
      },
    };
  });
  const result = await compile(proc);
  expect(result.wasm.byteLength).toBeGreaterThan(0);
  const memory = result.memory as unknown as {
    regions: {
      payloadContent: {
        eventSlots: Record<string, { base: number; capacity: number }>;
        messageSlots: Record<string, { base: number; capacity: number }>;
      };
    };
  };
  expect(memory.regions.payloadContent.eventSlots["result"]).toBeDefined();
});

test("typed-array event emitIf requires a length field (= guard)", () => {
  expect(() =>
    defineProcessor(() => {
      const buf = state.buffer.f32({ size: 4 });
      const result = event<{ data: Float32Array }>({
        to: "main",
        name: "result",
        payloadCapacity: 64,
      });
      return {
        process: () => {
          // Omitting length must throw.
          (result as unknown as { emitIf(c: boolean, p: unknown): void }).emitIf(true, {
            atSample: 0,
            data: buf,
          });
        },
      };
    }),
  ).toThrow(/requires a "length" field/);
});

test("buf.copyFrom rejects a non-payload source (= type guard)", () => {
  expect(() =>
    defineProcessor(() => {
      const buf = state.buffer.f32({ size: 8 });
      return {
        process: () => {
          // Passing a non-payload-field value (no PAYLOAD_FIELD_META) must throw.
          (buf as unknown as { copyFrom(x: unknown): void }).copyFrom({ length: 4 });
        },
      };
    }),
  ).toThrow(/typed-array message payload field/);
});

// A message<T> and an event<T> with the same name occupy independent namespaces.
// Typed-array content regions are partitioned by kind, so same-named entries
// always map to distinct regions. (Keying only by name would alias them,
// causing silent cross-channel corruption — this test is a regression guard.)
// The layout invariant is verified at compile time; per-channel value equality
// in end-to-end scenarios is covered separately by offline black-box tests.
test("same-named message and event get distinct content regions (namespace is kind-scoped, alias prevention)", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const inMsg = event<{ x: Float32Array }>({ from: "main", name: "dup" }); // main → worklet (message)
    const outEvt = event<{ x: Float32Array }>({ to: "main", name: "dup", payloadCapacity: 64 }); // worklet → main (event)
    const buf = state.buffer.f32({ size: 4 });
    return {
      process: () => {
        inMsg.onReceive(({ x }) => {
          buf.write(0, x.at(0)); // use message typed-array field (= payloadElementType seal)
        });
        buf.write(1, f32(99));
        outEvt.emitIf(true, { atSample: 0, x: buf, length: i32(1) }); // use event typed-array field
        forSample((i) => {
          out.ch(0).at(i).write(buf.read(0));
        });
      },
    };
  });
  const result = await compile(proc);
  expect(result.wasm.byteLength).toBeGreaterThan(0);
  const memory = result.memory as unknown as {
    regions: {
      payloadContent: {
        eventSlots: Record<string, { base: number }>;
        messageSlots: Record<string, { base: number }>;
      };
    };
  };
  const ev = memory.regions.payloadContent.eventSlots["dup"];
  const ms = memory.regions.payloadContent.messageSlots["dup"];
  expect(ev).toBeDefined();
  expect(ms).toBeDefined();
  // Even with the same name, event and message occupy separate regions so neither corrupts the other.
  expect(ev!.base).not.toBe(ms!.base);
});

// §5.1: A payload (T) may contain at most one variable-length (typed-array) field.
// Multiple such fields cannot be transported because a slot holds only a single
// [payloadLen, payloadOffset] pair — this must be caught as a graph-capture-time error.
// Verified on the message-receive side (both a.at() and b.at() seals trigger it).
test("payload with multiple typed-array fields is rejected at compile time (§5.1 single-field limit)", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const msg = event<{ a: Float32Array; b: Float32Array }>({ from: "main", name: "two" });
    const buf = state.buffer.f32({ size: 4 });
    return {
      process: () => {
        msg.onReceive(({ a, b }) => {
          buf.write(0, a.at(0)); // seal a as a typed-array field
          buf.write(1, b.at(0)); // sealing b as a second typed-array field — must be rejected
        });
        forSample((i) => out.ch(0).at(i).write(buf.read(0)));
      },
    };
  });
  await expect(compile(proc)).rejects.toThrow(/multiple-typed-array-fields/);
});

// Q71: All emit sites for an event<T> must declare the same field set.
// checkSealedEventField already enforces this for scalar fields on non-first emits,
// but typed-array fields must be subject to the same rule: if a subsequent emit site
// introduces a field not sealed at the first site, it must be rejected.
// (Without this guard, the extra array field would be silently ignored instead of
// raising a Q71 field-set error.)
test("event emit: subsequent site adding an unsealed typed-array field is rejected (Q71)", () => {
  expect(() =>
    defineProcessor(() => {
      const out = audioOutput({ channels: 1, name: "main" });
      const buf = state.buffer.f32({ size: 4 });
      const evt = event<{ a: number }>({ to: "main", name: "evt", payloadCapacity: 64 });
      return {
        process: () => {
          evt.emitIf(true, { atSample: 0, a: i32(1) }); // first site seals [a]
          // Subsequent site adds unsealed typed-array "x" (cast to bypass types) — Q71 field-set violation
          (evt as unknown as { emitIf(c: boolean, p: Record<string, unknown>): void }).emitIf(
            true,
            {
              atSample: 0,
              a: i32(1),
              x: buf,
              length: i32(4),
            },
          );
          forSample((i) => out.ch(0).at(i).write(f32(0)));
        },
      };
    }),
  ).toThrow(/typed-array field|field set/i);
});
