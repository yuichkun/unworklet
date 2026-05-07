<script setup>
const tryItCode0 = `import { defineProcessor, audioInput, audioOutput, forSample, mul } from "@unworklet/core";

// Both writes target channel 0 — second shadows first.
export const dup = defineProcessor(() => {
  const main = audioInput({ channels: 1, name: "main" });
  const out = audioOutput({ channels: 1, name: "main" });
  return {
    process: () => {
      forSample((i) => {
        out.set(0, i, mul(main.at(0, i), 0.5));    // shadowed
        out.set(0, i, mul(main.at(0, i), 0.7));    // wins
      });
    },
  };
});
`;
</script>

# Static analysis + diagnostics

The compiler runs a static analysis pass before WASM emission. Diagnostics are surfaced as **error** (compile fails), **warning** (compiles, surfaced), or **info** (metric).

## CLI

```sh
unworklet analyze ./my-processor.ts
```

Sample output:

```
Analyze: stereoGain
  metrics:
    states:        2
    buffers:       0
    params:        1
    audioInputs:   1
    audioOutputs:  1
    forSample:     1
    everyNSamples: 0
    ops/block:     ~280  (~107520 ops/s @ 48kHz)
    memory:        2616 bytes (1 page)
  diagnostics:
    INFO  [allocation-free]  No allocation primitives in the captured IR.
    INFO  [cycle-estimate]   Estimated ~280 ops/block.
```

## Layer-3 codes

| Code | Level | Meaning |
|---|---|---|
| `audio-output-not-written` | error | Declared `audioOutput` is never set. |
| `loop-stride-not-divisor` | warning | `forSample.byN(N, ...)` where N doesn't divide renderQuantum. Trailing samples skipped. |
| `loop-not-statically-bounded` | error | Negative or non-integer stride. |
| `atSample-out-of-block` | warning | Static-const `atSample` falls outside `[0, renderQuantum)`. |
| `denormal-prone-filter` | warning | One-pole-style state update with constant in `(0.9, 1.0)`. Add `flushDenormals(...)`. |
| `duplicate-output-write` | warning | Same `audioOutput` channel written twice in one body. Second shadows first. |
| `param-unused` | warning | Declared param never read. |
| `memory-budget-exceeded` | error | Total linear memory > budget (default 64 MiB). |
| `allocation-free` | info | Attestation — no alloc nodes in IR. |
| `cycle-estimate` | info | Rough op count per block + per second. |

## Three-layer error model

- **Layer 1** (TypeScript): types catch obvious mistakes (passing a number where a Buffer was expected, etc.) at IDE time.
- **Layer 2** (graph capture): runtime errors during the `defineProcessor` body — e.g. trying to call `forSample.byN(7, ...)` (not a power of 2) throws a structured `UnworkletCompileError` with refactor hint.
- **Layer 3** (static analysis): the codes above. Run before WASM emission.

Each error carries:

```ts
{
  layer: 2 | 3,
  code: "duplicate-output-write",
  message: "audioOutput \"main\" channel 0 is written 2× in the same forSample body — only the last write is observable.",
  refactorHint: "Combine the writes into a single .set() call, or guard each with a different sample-position so they don't collide.",
  loc: { file: "src/my.ts", line: 27, col: 5 },
}
```

## Programmatic API

```ts
import { compileToWasm, analyze } from "@unworklet/compiler";
import { myProcessor } from "./my-processor";

const r = compileToWasm(myProcessor, { sampleRate: 48000 });
const a = analyze(r.graph, r.layout);

console.log(a.metrics);
for (const d of a.diagnostics) {
  console.log(`${d.level} [${d.code}] ${d.message}`);
  if (d.refactorHint) console.log(`  hint: ${d.refactorHint}`);
}
```

## Live: trigger a warning

<TryIt label="duplicate writes" :code="tryItCode0" />

The TryIt block does compile + run (the first write is silently shadowed). To see the warning, run `unworklet analyze ./this-file.ts` in a terminal.
