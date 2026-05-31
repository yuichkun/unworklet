/**
 * Graph-capture-time (Layer 2) enforcement checks (`03-compiler.md` §2.6).
 *
 * These are realtime-safety / surface-contract violations the type system
 * cannot express, rejected during proxy evaluation of the `defineProcessor`
 * body (= `defineProcessor(...)` throws synchronously at capture).
 */

import { expect, test } from "vite-plus/test";

import "./primitives.ts";
import { f32 } from "./constructors.ts";
import { event, audioInput, audioOutput, param, state } from "./declarations.ts";
import { forSample } from "./loop.ts";
import { compile } from "../compile/index.ts";
import { defineProcessor } from "../processor.ts";
import type { Node, TypedArrayFieldRef } from "../types.ts";

// ─────────────────────────────────────────────────────────────────────────
// audio-sample-offset-out-of-range (Q68): JS-literal sample offset outside
// [0, SAMPLES_PER_BLOCK - 1] (= 0..127) at an audio I/O / param `.at(k)`.
// ─────────────────────────────────────────────────────────────────────────

test("audioInput .at(literal) above 127 is a capture-time error", () => {
  expect(() =>
    defineProcessor(() => {
      const input = audioInput({ channels: 1, name: "main" });
      const out = audioOutput({ channels: 1, name: "main" });
      return {
        process: () => {
          out.ch(0).at(0).write(input.ch(0).at(128));
        },
      };
    }),
  ).toThrow(/audio-sample-offset-out-of-range/);
});

test("audioOutput .at(negative literal) is a capture-time error", () => {
  expect(() =>
    defineProcessor(() => {
      const out = audioOutput({ channels: 1, name: "main" });
      return {
        process: () => {
          out
            .ch(0)
            .at(-1)
            .write(0 as never);
        },
      };
    }),
  ).toThrow(/audio-sample-offset-out-of-range/);
});

test("param .at(literal) above 127 is a capture-time error", () => {
  expect(() =>
    defineProcessor(() => {
      const out = audioOutput({ channels: 1, name: "main" });
      const g = param.f32({ default: 1, min: 0, max: 1, automationRate: "k-rate" }).named("g");
      return {
        process: () => {
          out.ch(0).at(0).write(g.at(200));
        },
      };
    }),
  ).toThrow(/audio-sample-offset-out-of-range/);
});

test("a non-integer literal sample offset is a capture-time error", () => {
  expect(() =>
    defineProcessor(() => {
      const input = audioInput({ channels: 1, name: "main" });
      const out = audioOutput({ channels: 1, name: "main" });
      return {
        process: () => {
          out.ch(0).at(0).write(input.ch(0).at(3.5));
        },
      };
    }),
  ).toThrow(/audio-sample-offset-out-of-range/);
});

test("boundary offsets 0 and 127 are accepted", () => {
  expect(() =>
    defineProcessor(() => {
      const input = audioInput({ channels: 1, name: "main" });
      const out = audioOutput({ channels: 1, name: "main" });
      return {
        process: () => {
          out.ch(0).at(0).write(input.ch(0).at(0));
          out.ch(0).at(127).write(input.ch(0).at(127));
        },
      };
    }),
  ).not.toThrow();
});

test("the forSample loop-counter `i` offset is unrestricted (no literal check)", () => {
  expect(() =>
    defineProcessor(() => {
      const input = audioInput({ channels: 1, name: "main" });
      const out = audioOutput({ channels: 1, name: "main" });
      return {
        process: () => {
          forSample((i) => {
            out.ch(0).at(i).write(input.ch(0).at(i));
          });
        },
      };
    }),
  ).not.toThrow();
});

// ─────────────────────────────────────────────────────────────────────────
// payload-element-type-mismatch (Q31-c): `buf.copyFrom(payloadField)` whose
// field element type was already sealed to a different type (e.g. read via
// `.at()` = f32, then copied into a buffer.i32). The TS surface prevents the
// well-typed case; this is the Layer 2 backstop when the type binding is
// bypassed.
// ─────────────────────────────────────────────────────────────────────────

test("copyFrom of an f32-sealed payload field into an i32 buffer is a capture-time error", () => {
  expect(() =>
    defineProcessor(() => {
      const dst = state.buffer.i32({ size: 16 });
      const up = event<{ samples: Float32Array }>({ from: "main", name: "up" });
      return {
        process: () => {
          up.onReceive(({ samples }) => {
            samples.at(0); // seals the field element type to f32
            // Bypass the TS binding to exercise the Layer 2 guard.
            dst.copyFrom(samples as unknown as TypedArrayFieldRef<"i32">);
          });
        },
      };
    }),
  ).toThrow(/payload-element-type-mismatch/);
});

// ─────────────────────────────────────────────────────────────────────────
// memory-budget (Q30): the auto-summed declaration memory exceeds the WASM
// 32-bit linear-memory ceiling — compile rejects before emit.
// ─────────────────────────────────────────────────────────────────────────

test("a declaration sum over the 4 GiB ceiling makes compile reject", async () => {
  // 1.2e9 f32 elements × 4 bytes ≈ 4.8 GiB > 4 GiB. layout sizes it (pure
  // arithmetic, no allocation); the memory-budget error fires before emit.
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    state.buffer.f32({ size: 1_200_000_000 });
    return {
      process: () => {
        out
          .ch(0)
          .at(0)
          .write(0 as never);
      },
    };
  });
  await expect(compile(proc)).rejects.toThrow(/memory-budget/);
});

// ─────────────────────────────────────────────────────────────────────────
// handler-field-escape: a message/MIDI handler payload field read outside the
// handler body decodes an unset drain slot at emit time (= silent 0).
// ─────────────────────────────────────────────────────────────────────────

test("a message field read used outside its onReceive handler is rejected", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const m = event<{ slot: number }>({ from: "main", name: "m" });
    let escaped: Node<"i32"> | undefined;
    m.onReceive(({ slot }) => {
      escaped = slot as Node<"i32">;
    });
    return {
      process: () => {
        forSample((i) => {
          // `escaped` reads the message's drain slot, but here it is outside the
          // handler — emit would read an unset slot pointer (= silent 0).
          out.ch(0).at(i).write(f32(escaped!));
        });
      },
    };
  });
  await expect(compile(proc)).rejects.toThrow(/handler-field-escape/);
});

test("a message field read used inside its onReceive handler compiles (no false escape)", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const m = event<{ slot: number }>({ from: "main", name: "m" });
    const sel = state.named("sel").i32(0);
    m.onReceive(({ slot }) => {
      // Read inside the handler body — the canonical, valid usage.
      sel.write(slot as Node<"i32">);
    });
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(0);
        });
      },
    };
  });
  const { wasm } = await compile(proc);
  expect(wasm).toBeInstanceOf(Uint8Array);
});
