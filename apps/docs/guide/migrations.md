<script setup>
const tryItCode0 = `import {
  defineProcessor, audioInput, audioOutput, state, forSample, mul,
} from "@unworklet/core";

// v2 of a processor that renamed "level" → "amplitude" between versions.
export const myFx = defineProcessor(
  () => {
    const _in = audioInput({ channels: 1, name: "in" });
    const out = audioOutput({ channels: 1, name: "out" });
    // The slot was named "level" in v1; "amplitude" in v2. Restoring a
    // v1 blob runs the migrate() below, which copies level → amplitude.
    const amplitude = state.f32(0.5, { name: "amplitude", snapshot: "persistent" });
    return {
      process: () => {
        forSample((i) => out.set(0, i, mul(amplitude.load(), 0.3)));
      },
    };
  },
  {
    migrations: [
      {
        // (Real hashes are computed at compile time and pinned to the
        // exact v1/v2 schemas. The playground does not run this leg —
        // it is shown to illustrate shape.)
        from: "v1HashHere",
        to:   "v2HashHere",
        migrate: (oldBlob, helpers) => {
          const v = helpers.parseSlot(oldBlob, "level", "f32");
          if (typeof v === "number") helpers.writeSlot("amplitude", "f32", v);
        },
      },
    ],
  },
);
`;
</script>

# Migrations

When you ship v2 of a processor with renamed/new/removed slots, the schema hash changes. Old user sessions saved against v1 then fail to restore. Migrations declare *how* to transform a v1 blob into a v2-compatible one.

## Declaring a migration chain

```ts
export const myFx = defineProcessor(
  () => {
    // ... v2 body, with slot named "amplitude" (was "level" in v1) ...
  },
  {
    migrations: [
      {
        from: "a3f2c1d0",   // v1 schema hash
        to:   "b8c14fe2",   // v2 schema hash (must match this processor's current hash)
        migrate: (oldBlob, helpers) => {
          const v = helpers.parseSlot(oldBlob, "level", "f32");
          if (typeof v === "number") helpers.writeSlot("amplitude", "f32", v);
        },
      },
      // Multi-step migrations work too — the framework walks the chain.
      {
        from: "b8c14fe2",
        to:   "d7e3a991",
        migrate: () => { /* identity transform; new param defaulted by name match */ },
      },
    ],
  },
);
```

## How it runs

1. `node.restore(blob)` parses the blob's schema hash.
2. If it matches the current processor's hash → restore directly.
3. If not, find a migration chain `oldHash → ... → currentHash`.
4. Apply each `migrate(blob, helpers)` step on the host (a transient JS Engine handles parsing and writing).
5. Re-encode the resulting state into the WASM-format blob.
6. Send to the worklet via the same `restore` port message.

If no chain exists, `restore` returns `{ skipped: ["schema-mismatch"], error: "schema-mismatch" }` — the framework refuses to silently corrupt state.

## Migration helpers

```ts
helpers.parseSlot(blob, "level", "f32"): number | undefined
helpers.parseBuffer(blob, "ir", "f32"): Float32Array | undefined
helpers.parseParam(blob, "gain"): number | undefined
helpers.writeSlot("amplitude", "f32", value)
helpers.writeBuffer("irL", "f32", float32Array)
helpers.writeParam("gain", value)
helpers.oldSchemaHash: string  // for branching on multi-version chains
```

Slots with the **same name + type** survive across schema changes automatically — the migration step is only needed for renames, type changes, splits, or merges.

## Live: rename slot

<TryIt label="v2 with migration" size="tall" source="silent" :code="tryItCode0" />

In a real shipping app the hashes are pinned automatically by `unworklet build`; you only write the `migrate` body.
