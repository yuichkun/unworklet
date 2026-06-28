/**
 * Layer C (Tier-0) — the payload-content region must stay 4-aligned.
 *
 * A typed-array event/message field keeps each payload in its own chunk of
 * `perPayload` bytes. The main side reads a field by building a `Float32Array`
 * view at `contentOffset + chunkIndex * perPayload`, which throws `RangeError`
 * on a non-4-aligned offset. A custom `payloadCapacity` need not be a multiple
 * of 4, so the layout rounds the per-chunk size up — proved here: every chunk
 * offset is 4-aligned and a `Float32Array` view over it does not throw.
 */

import "../dsl/primitives.ts";

import { expect, test } from "vite-plus/test";

import { audioOutput, event, state } from "../dsl/declarations.ts";
import { forSample } from "../dsl/loop.ts";
import { captureProcessor } from "../processor.ts";
import { layout } from "./layout.ts";

test("a non-multiple-of-4 payloadCapacity is rounded so every chunk stays f32-viewable", () => {
  const graph = captureProcessor(() => {
    const out = audioOutput({ channels: 1, name: "out" });
    // 10 bytes per payload is NOT a multiple of 4 — the misalignment trigger.
    const scope = event<{ samples: Float32Array }>({
      to: "main",
      name: "scope",
      payloadCapacity: 10,
    });
    const ring = state.buffer.f32({ size: 4 });
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(0);
        });
        scope.emitIf(true, { samples: ring, length: 4 });
      },
    };
  }, 48000);

  const slot = layout(graph).regions.payloadContent.eventSlots["scope"]!;
  const perPayload = slot.capacity / slot.chunks;
  expect(perPayload % 4).toBe(0); // 10 rounded up to 12

  // The main side views each chunk as a Float32Array over the content SAB
  // (which starts at offset 0); a misaligned chunk offset would throw.
  const buf = new ArrayBuffer(slot.capacity);
  for (let chunk = 0; chunk < slot.chunks; chunk++) {
    expect(() => new Float32Array(buf, chunk * perPayload, perPayload >> 2)).not.toThrow();
  }
});
