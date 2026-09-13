# v0.3.0 release candidate

This release focuses on dependable audio processing, useful failure messages,
and shorter development cycles.

**Not ready for publication:** unresolved transport and code-generation defects
are listed in [RELEASE-VALIDATION.md](./RELEASE-VALIDATION.md), together with the
completed and pending checks.

## What users gain

- Event and MIDI ring consumption flows back to the producer. Shared outbound
  messages are read from consistent snapshots, including typed payloads and
  sysex. A hidden page continues draining through a timer; capacity limits and
  browser scheduling still apply.
- SIMD stores preserve their value when their offset contains vector arithmetic.
  Buffer feedback flushes subnormals, and non-finite output is scrubbed with a
  diagnostic count.
- An optional processor identity protects presets against cross-processor
  restores. Snapshot v1 remains readable.
- Repeated offline renders reuse compilation without sharing mutable state.
  Analysis artifacts are opt-in and capped during serialization.
- Unsupported buffer publishing, sysex boundaries, and processor-file exports
  report errors at their source instead of failing indirectly.

## Migration

The nine public surface changes and their migrations are in
[CHANGELOG.md](./CHANGELOG.md#breaking). This includes the processor export rule:
a `.uwk.ts` containing `process()` cannot contain authored module-level exports,
including types and re-exports. Place shared declarations in a separate `.ts` or
library-only `.uwk.ts` and import them into the processor. A library-only file
contains no `process()` and keeps its exports. Shared declarations are not
automatically moved across statements.

## Guarantee boundaries

The emitted DSP uses fixed memory and bounded work. Audio-thread transport never
waits for main-thread consumption: a contended shared-memory publication is
postponed, with backlog retained in the bounded WASM ring. Exceeding its capacity
uses the ring's drop-oldest policy and diagnostics.

The `postMessage` compatibility transport remains available. Its message delivery,
buffer recycling, and control traffic can allocate and trigger GC on the audio
thread. It has no allocation-free or GC-free guarantee. This exception does not
permit unbounded DSP work or blocking.

A successful compile and passing tests do not guarantee the absence of every
implementation bug, browser scheduling delay, or audio-device problem. Chromium
is the automated browser target; Firefox and Safari have no equivalent automated
release gate in this repository.

## Listening check

Run `vp dev` from `examples/demo`, open the displayed local URL, and use the
existing examples. Start with a low monitoring level.

1. Play a synth, change its controls, and release its notes. Check for unexpected
   silence, clicks, or stuck notes.
2. Run an effect on a steady input and change its parameters. Check that the
   intended changes are audible and no unrelated part of the sound changes.
3. Switch to another browser tab and return. Check that sound continues and
   controls respond on return.
4. Save and restore a preset for the same processor. Check its audible settings.

The unattended transport check is
`vp exec node scripts/release-soak/run.mjs`. Its default duration is 30 minutes
for each transport. A preflight of shorter duration is only a harness check.

Publication, a release tag, and remote PR changes require the owner's approval
of the candidate and its verification results.
