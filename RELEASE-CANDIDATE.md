# v0.3.0 — examples and migration

This document describes the **stabilized v0.3.0 PR branch**. The comparisons below
use v0.2.0's implementation, the pre-stabilization PR commit `2f77068`, and the
stabilized implementation. References to the earlier PR head describe that
historical comparison point, not the branch containing this document.
The examples were executed; output values are not inferred from the change names.

## 1. Repeated offline renders compile once, with fresh state each time

An audio test suite can reuse one processor object across separate renders:

```ts
import { loadUwkProcessor } from "@unworklet/lang";
import { renderOffline } from "@unworklet/offline";

const processor = await loadUwkProcessor("./counter.uwk.ts");
const config = { sampleRate: 48000, duration: 128 / 48000 };

const first = await renderOffline(processor, config);
const second = await renderOffline(processor, config);
const third = await renderOffline(processor, config);
```

For a small `counter.uwk.ts` that emits a ramp:

```ts
const count = state.f32(0);
const out = audioOutput({ channels: 1, name: "main" });
process(() =>
  forSample((i) => {
    out.ch(0)[i] = count / 128;
    count.write(count + 1);
  }),
);
```

The observed `WebAssembly.compile` count for these three renders is **3 in
v0.2.0, 1 at the pre-stabilization PR (`2f77068`), and 1 in the candidate**. Every render starts its output
at `0`; caching does not continue the preceding render's counter. The cache is
in-process, keyed by processor object and sample rate. Loading another object or
using another rate requires its own compilation.

## 2. A processor can reply to a UI message and keep using the received value

`value-message.uwk.ts` receives a value, acknowledges it, uses it to set the audio
output, and sends a second reply:

```ts
const control = event<{ value: number }>({ from: "main" });
const ack = event<{ value: number }>({ to: "main" });
const later = event<{ value: number }>({ to: "main" });
const held = state.f32(0).named();
const out = audioOutput({ channels: 1, name: "main" });

process(() => {
  control.onReceive(({ value }) => {
    ack.emitIf(bool(true), { value });
    held.write(value * 2);
    later.emitIf(bool(true), { value: value + 1 });
  });
  forSample((i) => {
    out.ch(0)[i] = held;
  });
});
```

The application sends the message and subscribes to its replies:

```ts
node.events.ack.on(({ value }) => console.log("ack", value));
node.events.later.on(({ value }) => console.log("later", value));
node.events.control.emit({ value: 0.25 });
```

For a 128-sample render with this input:

| Implementation                                  | Observed result                                                            |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| v0.2.0 and the pre-stabilization PR (`2f77068`) | Processing does not return within the 8-second worker deadline             |
| Candidate                                       | `ack.value === 0.25`, `later.value === 1.25`, all output samples are `0.5` |

The fix allows this ordinary request/reply pattern without splitting the handler
or copying values in application code to avoid the bug. It is included in this
stabilized PR branch.

## 3. A queue of 32 array messages retains 17 distinct payloads

The declaration below allows 32 queued messages, each containing four f32 values:

```ts
// array-retention.uwk.ts
const upload = event<{ id: number; samples: Float32Array }>({
  from: "main",
  capacity: CAPACITY_32,
  payloadCapacity: 16,
});
const received = state.buffer.f32({ size: 85 }).expose({
  name: "received",
  snapshot: "persistent",
});
const count = state.i32(0).named("count");
const out = audioOutput({ channels: 1, name: "main" });

process(() => {
  upload.onReceive(({ id, samples }) => {
    const offset = count * 5;
    received[offset] = id;
    received[offset + 1] = samples.at(0);
    received[offset + 2] = samples.at(1);
    received[offset + 3] = samples.at(2);
    received[offset + 4] = samples.at(3);
    count.write(count + 1);
  });
  forSample((i) => {
    out.ch(0)[i] = f32(0);
  });
});
```

```ts
import { inspect } from "@unworklet/core";
import { loadUwkProcessor } from "@unworklet/lang";
import { renderOffline } from "@unworklet/offline";

const processor = await loadUwkProcessor("./array-retention.uwk.ts");
// All 17 messages arrive before processing the block.
const messages = Array.from({ length: 17 }, (_, id) => ({
  name: "upload",
  payload: {
    id,
    samples: new Float32Array([id, id + 0.25, -id, id + 0.5]),
  },
}));
const result = await renderOffline(processor, {
  sampleRate: 48000,
  duration: 128 / 48000,
  messages,
});
console.log(inspect(result.state).slots.received);
```

The complete receiving example saves each `[id, ...samples]` in a persistent
buffer, without emitting a reply. This keeps the retention test separate from
the request/reply bug above.

| Implementation                                  | First received record                               | Last received record         |
| ----------------------------------------------- | --------------------------------------------------- | ---------------------------- |
| v0.2.0 and the pre-stabilization PR (`2f77068`) | `[0, 16, 16.25, -16, 16.5]` — ID 0 has ID 16's data | `[16, 16, 16.25, -16, 16.5]` |
| Candidate                                       | `[0, 0, 0.25, 0, 0.5]`                              | `[16, 16, 16.25, -16, 16.5]` |

All 17 records are checked. This is not an overflow case: 17 is below the
configured capacity of 32.

**Migration:** retaining the requested payloads increases memory use for
capacities above 16. Choose `payloadCapacity` for one message, in bytes, and
`capacity` for the number of queued messages. The example uses 32 × 16 = 512
bytes for array contents in audio-processing memory, plus transport storage.
Defaults use 256 × 65,536 = **16 MiB per array event**, plus transport storage.
Oversized arrays are truncated to the aligned per-message limit. SysEx storage
also follows the MIDI port's capacity; it defaults to 256 KiB plus transport
storage. These changes are included in this stabilized PR branch.

## 4. Check diagnostics as well as finite audio output

This intentionally broken `scrubbed-output.uwk.ts` divides zero by zero:

```ts
const numerator = state.f32(0);
const denominator = state.f32(0);
const out = audioOutput({ channels: 1, name: "main" });
process(() =>
  forSample((i) => {
    out.ch(0)[i] = numerator / denominator;
  }),
);
```

For 128 mono samples, v0.2.0 returns NaN samples. Both the pre-stabilization PR (`2f77068`) and candidate
return 128 zero samples and `diagnostics.scrubbedSamples === 128`.

That affects how an audio test detects the bug:

```ts
expectNoNaN(result); // Passes: the invalid output was replaced with zero.
expect(result.diagnostics.scrubbedSamples).toBe(0); // Fails for this 0/0 example.
```

Use the diagnostic assertion when the test is intended to establish that the
processor computed valid audio, not merely that its returned buffer is finite.
The count records corrections; it does not repair the underlying DSP expression.

## 5. Preset IDs distinguish processors with the same state declarations

Two instruments can both declare a persistent `preset` value but interpret it
differently. Give them distinct, stable identities:

```ts
// preset-a.uwk.ts
options({ id: "instrument-a" });

// preset-b.uwk.ts
options({ id: "instrument-b" });
```

Saving A with `preset = 0.125` and restoring it into B is accepted by v0.2.0.
In the executed example, B's output changes from its default `0.5` to `0.25`.
The PR head and candidate reject the same offline restore with
`processor-mismatch`. The live `node.restore()` equivalent returns
`{ ok: false, error: { step: "identity", ... }, ... }`.

The check requires an ID on **both** the saved preset and the target processor.
Without IDs, the executed restore still succeeds. Keep an instrument's ID stable
across releases. Presets saved by 0.2.x remain readable; presets saved by 0.3.0
cannot be read by 0.2.x.

## 6. Move shared types and constants out of a processor file

A type exported from a processor `.uwk.ts` is accepted by v0.2.0 and the pre-stabilization PR (`2f77068`):

```ts
// Before: inside a .uwk.ts file that also contains process(...).
export type Setting = { value: number };
```

The candidate rejects it with `uwk-export-unsupported`. The same rule covers
value exports and re-exports. Put the shared declarations in `shared.ts`:

```ts
export const LEVEL = 0.375;
export type Setting = { value: number };
```

Then import them into the processor, and from the UI wherever needed:

```ts
import { LEVEL, type Setting } from "./shared.ts";
const setting = event<Setting>({ from: "main" });
const held = state.f32(LEVEL).named();
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  setting.onReceive(({ value }) => held.write(value));
  forSample((i) => {
    out.ch(0)[i] = held;
  });
});
```

This complete import-based processor renders `0.375` in all three implementations.
A shared `.uwk.ts` file without `process()` can also export definitions. Cross-file
examples use `loadUwkProcessor(path)` or the bundler; the in-memory/browser source
compiler does not gain a cross-file module loader.

The stabilization removes the earlier PR's attempt to move exported definitions
out of processor code. That attempt still changes some initializers' values at
commit `2f77068`; it is not being advertised as a finished sharing feature.

## 7. Explicit node annotations accept the result of createNode

```ts
import { createNode, type UnworkletNode } from "@unworklet/core";
import processor from "./value-message.uwk.ts?worklet";

export async function connect(context: AudioContext) {
  let node: UnworkletNode<typeof import("./value-message.uwk.ts?worklet")>;
  node = await createNode(context, processor);
  node.events.control.emit({ value: 0.25 });
  return node;
}
```

Both the compiled-value and module-namespace assignments produce TS2322 against
the v0.2.0 and pre-stabilization public types in the comparison probe. The candidate
accepts this annotation and `UnworkletNode<typeof processor>`.
Malformed payloads such as `{ value: "0.25" }` and undeclared ports remain type
errors. This is a fix for naming and assigning the handle type, not a claim that
all `.uwk.ts` type-witness limitations are resolved.

## Other changes and affected code

| If your code does this…                                            | Change / migration                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publishes a whole buffer with `.expose({ publish: ... })`          | Build error `buffer-publish-unsupported`. Publish scalar meter/state values, or read the buffer through `snapshot()`                                                                                                                                                                        |
| Uses SIMD `loadVec` / `storeVec`                                   | Offsets clamp to a complete four-element window. Buffers smaller than four elements are rejected. The candidate also fixes the PR's computed-store-offset regression                                                                                                                        |
| Sends SysEx                                                        | Messages must fit 1,020 bytes including framing. Main `send()` rejects oversized messages and unsupported ports. A known invalid outbound length fails compilation; a runtime-invalid length is discarded and counted. Candidate offline input also rejects oversize rather than truncating |
| Reads `graph.json`, `memory.json`, etc. from build output          | Enable `unworklet({ emitAnalysisArtifacts: true })`. Default is false; serialization stops when its estimated 8 MiB budget is exceeded                                                                                                                                                      |
| Hand-builds a `RenderOfflineResult` fixture                        | Add `diagnostics`, or use matcher input `RenderResultLike`, where it is optional                                                                                                                                                                                                            |
| Hand-builds `InspectionResult` / `DecodedSnapshot`                 | Add `processorId: null` if the preset has no identity                                                                                                                                                                                                                                       |
| Implements or mocks `CompileInstance`                              | Provide `scrubbedSamples()` and `droppedSysexMessages()`                                                                                                                                                                                                                                    |
| Reads or mocks `DevNodeHandle.devDump()`                           | It returns `{ slots, scrubbedSamples }`; read `.slots` instead of treating the result as an array                                                                                                                                                                                           |
| Declares or imports a reserved name in `.uwk.ts`                   | Follow `uwk-reserved-binding` to rename/alias it. `defineProcessor` is reserved; automatic I/O also reserves the generated I/O names                                                                                                                                                        |
| Exports an explicit-core `.processor.ts` as both named and default | The same processor object is accepted under both names. A default-only processor also emits a valid `?worklet` module                                                                                                                                                                       |
| Builds with an extensionless local processor import                | The failure explains the extension rule and suggests the existing target, rather than a raw missing-module error                                                                                                                                                                            |
| Inspects or migrates boolean preset buffers                        | Candidate returns logical elements: a 128-element bool buffer has length 128, with note index 2 at element 2, not length 512/index 8                                                                                                                                                        |

Delay/reverb float buffers also flush values below `1e-30` to zero. Continuous
output-event/MIDI reception no longer reports overflow simply because lifetime
traffic exceeds capacity, and hidden tabs continue receiving notifications under
browser timer rules. Actual overload can discard old messages and is diagnosed.
DevTools SysEx injection/logging and abandoned-build temporary cleanup are fixed.

`postMessage` remains the compatibility path when SharedArrayBuffer is unavailable.
It reuses output-transfer storage, but receiving, recycling and control traffic
can allocate and trigger GC. The complete fallback audio thread is not guaranteed
allocation-free or GC-free.

## Verification and scope

The accompanying runnable examples contain exact assertions. The 0.2.0 comparison
uses source identical to the v0.2.0 tag; only RELEASE.md differs at the PR base.
All three source revisions use the same dependency installation for comparison.
The candidate examples are also tested against its packed packages. Browser/API
checks and the 30-minute runs are recorded separately in
[RELEASE-VALIDATION.md](./RELEASE-VALIDATION.md); they apply to the stabilized implementation,
not to the pre-stabilization commit `2f77068`. GitHub CI for the pushed branch
is a separate check. No package has been published.
