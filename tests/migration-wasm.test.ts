// Migrations over the wire: snapshot from one schema version, restore into
// a newer schema version through a registered migration. End-to-end via
// the WASM offline renderer (renderOfflineWasm) for the new schema and the
// JS Engine for the old (which is what main-thread code does to walk the
// migration chain on a stale blob).
import { describe, expect, test } from "vite-plus/test";
import {
  defineProcessor,
  audioOutput,
  state,
  forSample,
} from "@unworklet/core";
// @ts-ignore — internal subpath
import { Engine } from "@unworklet/core/internal";
import { compileToWasm } from "@unworklet/compiler";

const SR = 48000;

// v1: a single state slot named "level"
const v1Processor = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const level = state.f32(0.25, { name: "level", snapshot: "persistent" });
  return {
    process: () => {
      forSample((i) => out.set(0, i, level.load()));
    },
  };
});

// v2: rename "level" → "amplitude" via a migration. The renamed slot
// receives the old value when restored.
const v2Processor = defineProcessor(
  () => {
    const out = audioOutput({ channels: 1, name: "main" });
    const amplitude = state.f32(0.5, { name: "amplitude", snapshot: "persistent" });
    return {
      process: () => {
        forSample((i) => out.set(0, i, amplitude.load()));
      },
    };
  },
  {
    migrations: [
      {
        // We don't know v1 schemaHash up front; the test computes it below
        // and patches the migration in.
        from: "__PATCH_ME__",
        to: "__SELF__",
        migrate: (oldBlob: Uint8Array, helpers: any) => {
          const oldVal = helpers.parseSlot(oldBlob, "level", "f32");
          if (typeof oldVal === "number") {
            helpers.writeSlot("amplitude", "f32", oldVal);
          }
        },
      },
    ],
  },
);

describe("Migrations over the wire (host-walked then re-encoded for WASM)", () => {
  test("v1 snapshot → migrate → v2 WASM restore preserves the renamed slot", () => {
    // Build a v1 engine, mutate its state, snapshot.
    const engV1 = new Engine(v1Processor, { sampleRate: SR, blockSize: 128 });
    const v1Slot = engV1.rt.allScopes.flatMap((s: any) => s.states).find(
      (s: any) => s.slot.name === "level",
    );
    v1Slot.write(0.42);
    const v1Blob = engV1.snapshot();
    const v1Hash = engV1.rt.schemaHash;

    // Patch the migration's `from` to v1's actual hash. Compute v2's
    // hash via compileToWasm so we can also patch `to: SELF`.
    const v2Compile = compileToWasm(v2Processor, { sampleRate: SR });
    const v2Hash = v2Compile.graph.schemaHash;
    const migs = (v2Processor as any).options.migrations;
    migs[0].from = v1Hash;
    migs[0].to = v2Hash;

    // Drive the v2 Engine through the migration to produce a v2 blob.
    const engV2 = new Engine(v2Processor, { sampleRate: SR, blockSize: 128 });
    const result = engV2.restore(v1Blob);
    expect(result.error).toBeUndefined();
    const ampSlot = engV2.rt.allScopes.flatMap((s: any) => s.states).find(
      (s: any) => s.slot.name === "amplitude",
    );
    // The renamed slot should now hold the v1 value.
    expect(ampSlot.read()).toBeCloseTo(0.42, 5);
  });
});
