# v0.3.0 release candidate

This release reduces the wait between offline audio tests and fixes problems
with audio calculations, UI-to-processor messages, MIDI, and presets. Review the
migration notes when upgrading an existing instrument or effect.

## Changes to the development experience

- **Repeated audio tests spend less time compiling.** `renderOffline` reuses the
  compilation of the same processor object at the same sample rate within a process. Each render starts
  with independent processor state, so one test does not inherit another test's
  notes or parameter changes. No change to the call is needed.
- **UI messages and MIDI are more reliable.** Fixes include processors stopping
  when replying to a UI message, duplicate delivery, and incorrect overflow
  reports during extended use. Event and MIDI reception continues in a hidden
  browser tab. Sending more than the configured capacity can still discard
  the oldest messages; delivery is not guaranteed under unlimited load.
- **Presets can identify the instrument they belong to.** Add
  `options({ id: "my-synth" })` to a `.uwk.ts` processor to include its identity
  in saved presets. Loading a preset with a different identity is rejected.
  This check requires identities on both the preset and the receiving processor.
- **Fixes for incorrect audio output.** Changes
  cover nested calculations and SIMD buffer operations. Unsupported settings,
  such as publishing an entire buffer, report a build error at the declaration.

## Upgrading an existing project

**Put shared definitions in a separate file.** A `.uwk.ts` file containing
`process()` cannot export extra constants, functions, or types. If the UI and
processor need the same parameter definitions, put them in `shared.ts` and
import them from both places. Type-only exports and re-exports follow this rule.
A shared `.uwk.ts` file without `process()` can export its definitions.

**Check memory settings if you send arrays or SysEx.** Each array event reserves
space for the requested number of messages. Defaults require 16 MiB of audio
processing memory per event, plus memory for transport. Set `payloadCapacity`
for the largest array in one message, in bytes, and `capacity` for the number
of queued messages. For example, 128 float samples need `payloadCapacity: 512`.
Larger arrays are truncated to the aligned per-message limit, so do not set it
below the data size you need. SysEx memory also grows with the MIDI port's
capacity.

**Keep preset compatibility in mind when switching versions.** Presets saved
with 0.2.x can be loaded. Presets saved with 0.3.0 cannot be read by 0.2.x; keep
separate copies if both versions need the same presets.

Additional migration items apply to buffer publishing, SysEx limits, SIMD buffer
sizes, analysis-file generation, hand-built test results, `devDump()`, and
reserved names in `.uwk.ts` files. The [changelog](./CHANGELOG.md#breaking) lists
the affected API and the required change for each item.

## Hosting and validation

Apps still run through the `postMessage` compatibility transport when the host
cannot provide SharedArrayBuffer. This path can allocate memory and trigger GC
on the audio thread; it has no allocation-free or GC-free guarantee.

The local candidate passes 2,842 tests, the 98% branch-coverage gate for every
package, package-install/build checks, and a 30-minute headless Chromium run on
each transport with real tab visibility changes. Firefox, Safari, physical MIDI
hardware, and listening on the user's audio device are not verified here.
[Validation results](./RELEASE-VALIDATION.md) include the measured outcomes and
remaining observations. The candidate has not been published.

## Listening check

Run `vp dev` from `examples/demo`, open the displayed local URL, and use the
existing examples. Start with a low monitoring level.

1. Play a synth, change its controls, and release its notes. Check for unexpected
   silence, clicks, or stuck notes.
2. Run an effect on a steady input and change its parameters. Check that the
   intended changes are audible and no unrelated part of the sound changes.
3. Switch to another browser tab and return. Check that sound continues and
   controls respond on return.

The isolated Orbit Echo acceptance demo also includes save/restore controls and
a five-second rendered listening sample. Its location and verification results
are recorded in the validation report.

The unattended transport check is
`vp exec node scripts/release-soak/run.mjs`. Its default duration is 30 minutes
for each transport, using headless Chromium with audio muted. It switches real
tab visibility without opening a browser window. `--headed` explicitly enables
a visible window. A preflight of shorter duration is only a harness check.

Publication, a release tag, and remote PR changes require the owner's approval
of the candidate and its verification results.
