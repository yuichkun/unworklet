<script setup>
const tryItCode0 = `import {
  defineProcessor, audioInput, audioOutput, state, forSample,
  add, mul, sin,
} from "@unworklet/core";

// A simple oscillator whose phase is persistent state. Snapshot it,
// then restore — the phase resumes where it left off.
export const phaseOsc = defineProcessor((ctx) => {
  const _in = audioInput({ channels: 1, name: "in" });
  const out = audioOutput({ channels: 1, name: "out" });
  const phase = state.f32(0, { name: "phase", snapshot: "persistent" });
  return {
    process: () => {
      const inc = 220 / ctx.sampleRate;
      forSample((i) => {
        const next = add(phase.load(), inc);
        phase.store(next);
        out.set(0, i, mul(sin(mul(phase.load(), 2 * Math.PI)), 0.3));
      });
    },
  };
});
`;
</script>

# Snapshot + restore

`node.snapshot()` returns a `Uint8Array` blob containing every persistent state slot + persistent buffer. `node.restore(blob)` reapplies it. Block-atomic: you observe a consistent snapshot of the audio thread's state at a single block boundary.

## Basic usage

```ts
const node = await createWasmNode(ctx, processor, "name");

// Capture
const blob = await node.snapshot();
localStorage.setItem("preset-1", btoa(String.fromCharCode(...blob)));

// ...later or on another machine...
const restored = Uint8Array.from(atob(localStorage.getItem("preset-1")!), c => c.charCodeAt(0));
const result = await node.restore(restored);
console.log(result);  // { restored: 5, skipped: [], missing: [] }
```

## Inspect without applying

`node.inspect(blob)` decodes header + schema hash + slot summary without touching audio:

```ts
const meta = node.inspect(blob);
console.log(meta.format);       // "wasm" or "engine"
console.log(meta.schemaHash);   // 8-char hex
console.log(meta.stateBytes);   // size of the state region
console.log(meta.bufferCount);  // number of persistent buffers
```

## Per-slot policy

Each declaration accepts a `snapshot:` option:

- `"persistent"` (default for state, param) — saved.
- `"transient"` (default for un-flagged buffers) — skipped on snapshot, untouched on restore.

```ts
const sessionState = state.f32(0, { snapshot: "persistent" });   // ✓ saved
const delayLine = buffer.f32({ size: 96000, name: "delayLine" }); // not saved (transient default)
const presetBuffer = buffer.f32({
  size: 4096, name: "presetBuffer", snapshot: "persistent",
});
```

## Schema hash

Every snapshot blob carries the **schema hash** — a stable identity derived from the processor's declarations (slot paths, types, snapshot policies, param names). On restore the hash must match the current processor's hash; otherwise the framework rejects with `error: "schema-mismatch"`.

This catches: you authored v1 of the processor with one set of slots, ship v2 with a renamed slot, and the user reopens an old session. Without schema validation you'd get garbled state. With it you get a clear failure — and an opportunity to migrate.

## Profiles

`snapshot({ profile: "quick" })` selects a per-profile policy mapping:

```ts
const wave = state.f32(0, {
  snapshot: { default: "persistent", quick: "transient" },
});
```

`node.snapshot()` and `node.snapshot({ profile: "quick" })` produce blobs with different content (the latter omits `wave`).

## Live snapshot/restore round-trip

<TryIt label="snapshot demo" size="tall" source="silent" :code="tryItCode0" />

In a real app: hit Run, listen for a few seconds (oscillator runs), call `node.snapshot()`, dispose, create a fresh node, call `node.restore(blob)` — the oscillator resumes from the same phase position, no click.

## See also

- [Migrations](./migrations) — what to do when the schema changes between versions.
