# v0.3.0 candidate validation

Status: **local release candidate prepared; publication awaits separate approval**. The candidate builds on PR #48
at `2f7706850b67b448c51746d3037c08436b50004f`, retaining its history and adding
local stabilization commits. The implementation checkpoint is `ba97653`. No remote update, merge, tag, or publication has
been performed. CI configuration is prepared; these local changes have not run
on GitHub Actions.

## Result for users

The candidate addresses incorrect nested audio calculations, stopped message
handlers, inconsistent event/MIDI copies in both shared-memory directions, and
payloads overwriting other retained messages. Processor-file exports produce an
error with a shared-file migration. Preset identities, v1 reading, numeric
hygiene, and compilation reuse remain covered by executable tests.

The extra three defects identified at the plan checkpoint are resolved within
the approved amendment: payload storage follows declared capacity, temporary
storage follows expression/handler lifetimes, and inbound copies use ownership
with bounded staging. No extra public send/receive API was introduced.

A guide-only consumer found two more inconsistencies within the planned usage
and preset checks. Explicit node annotations accept the created node while
retaining member/payload checks. Boolean preset inspection and migration helpers
use logical elements instead of treating four-byte storage as four booleans.
Both failures were reproduced before the corresponding fixes.

## Executed checks

| Check                                                               | Final result                                                                                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Root format, lint, typecheck                                        | Pass; zero errors, one existing `no-implied-eval` warning in the documentation-example harness                                 |
| Full root test aggregation                                          | 149 files / 2,842 tests pass, including both Chromium transports                                                               |
| Package builds                                                      | All five packages build                                                                                                        |
| Demo build                                                          | Pass                                                                                                                           |
| Demo offline examples                                               | 14 tests pass                                                                                                                  |
| Demo browser compilation                                            | 4 tests pass in headless Chromium                                                                                              |
| Packed package entry points                                         | All five tarballs pass strict publint                                                                                          |
| Packed package type resolution                                      | All five pass the repository's ESM-only ATTW profile                                                                           |
| Isolated guide-only consumer                                        | Cold typecheck/build, three node annotation forms, and 10 behavior tests pass                                                  |
| Consumer live browser operation                                     | Headless Chromium: MIDI in/out, control reply, nonzero audio-derived state, save/restore, and re-saved values pass             |
| Listening artifact                                                  | Five-second stereo 48 kHz float PCM WAV; finite samples, peak below -6 dBFS, zero correction diagnostics, exact WAV round trip |
| Both transports for 30 minutes with real hidden/visible transitions | Pass: fresh headless run completed on both transports                                                                          |

The package branch gate is measured separately for every package:

| Package  | Tests | Covered / total branches | Coverage |
| -------- | ----: | -----------------------: | -------: |
| core     | 1,120 |            2,469 / 2,519 |   98.01% |
| lang     | 1,088 |            1,010 / 1,026 |   98.44% |
| offline  |   146 |                141 / 142 |   99.29% |
| test     |   230 |                277 / 278 |   99.64% |
| unplugin |   166 |                258 / 263 |   98.09% |

CI enables the 98% branch threshold for each package and archives each report.
Coverage exclusions and thresholds were not relaxed. Improvements came from
behavior tests and removal of proven dead internal code; external-input checks
remain. The lang improvement uses tests alone.

The installed Vite+ test runner requests `@vitest/coverage-v8` 4.1.8 in its peer
metadata, and that exact provider is installed. Its comparison with the fork's
0.1.24 version prints a warning; measurements are not suppressed or inferred.

ATTW retains the existing ESM-only profile and `fallback-condition` exception.
The lang tsserver-plugin entry also retains `untyped-resolution`, because it is
loaded by name and intentionally has no public type declaration. No additional
packaging exception was added. CI packs through Vite+ and checks those tarballs.

## Sustained browser run

Both transports completed the requested 1,800-second run in headless Chromium,
with native tab selection and no override of `document.visibilityState`. Their
WASM SHA-256 matches a fresh compile of the committed processor source:
`9ed68ad77537af8af025f4a50f741a528ca8cd947ddb1bc882ebda14d2be11b0`.

| Measurement                                      |     Shared memory |       postMessage |
| ------------------------------------------------ | ----------------: | ----------------: |
| Wall duration                                    |        1,801.77 s |        1,802.28 s |
| AudioContext clock                               |        1,798.78 s |        1,798.58 s |
| Processing quanta                                |           674,532 |           674,438 |
| Hidden / visible duration                        | 900.50 / 901.27 s | 902.80 / 899.47 s |
| Observed hidden / visible transitions            |           16 / 16 |           16 / 15 |
| Received notifications, all six streams          |            51,188 |            51,176 |
| Gaps / duplicates / reversals / corrupt payloads |     0 / 0 / 0 / 0 |     0 / 0 / 0 / 0 |
| Overflow / reported errors / stalled intervals   |         0 / 0 / 0 |         0 / 0 / 0 |

All sent MIDI/sysex pairs returned. Each automatic scalar/typed/sysex stream
starts at sequence 1 with no gaps; the MIDI sequence also passes across its wire
counter wraps. Wall time and audio time are separate observations, not assumed
to be identical. The harness requires the full wall duration, continuing audio
and processor progress, consistent complete streams, and zero normal-rate loss.

The headed attempt was interrupted at the owner's request and is not counted
as a completed run. A separate headless preflight passed, followed by the fresh
full-duration run above. Browser and local server processes are closed when the
runner finishes. Raw per-transport receipts and metadata accompany the candidate.

## What the regressions establish

- Export rejection and moving the shared declarations into a separate file are
  tested as a pair. Library-only exports and imports still work. The removed
  hoisting analysis is not replaced with another callback/evaluation predictor.
- Nested scalar/vector arithmetic, interpolation, noise, input-field rereads,
  message replies, and sysex forwarding execute correctly. The stopped-handler
  regression runs in a worker with a deadline. Sequential operations reuse
  scratch instead of requiring one permanent temporary per operation.
- Outbound copies, inbound copies, typed payloads, sysex indexes above 255,
  contention, slow drains, overflow, counter wrap, reentrant callbacks/encoding,
  exceptions, and disposal have behavioral regressions. Audio makes one atomic
  acquisition attempt and never waits. Capacity overflow remains observable.
- The twelve golden processors retain the same graph, schema hash, PCM, and
  snapshot bytes. All twelve WASM hashes change with the temporary allocator;
  five memory layouts change because they contain typed payloads or sysex.
- Identity mismatches, v1 blobs, snapshot continuation, independent render state,
  and compile reuse remain exercised. Offline sysex at 1,020 bytes retains its
  terminator; 1,021 bytes is rejected instead of truncated.

The full aggregation initially found a browser fixture expecting one message to
borrow other messages' payload storage. Its expectation was corrected to the
specified per-message budget, including the DSL's clamped reads. The final
aggregation passes; the test was not skipped and the limit was not increased.

## Independent review and scope control

Two independent broad review rounds were used, followed by verification of the
second round's specific sysex finding. That finding is resolved. No third broad
review or recurring review automation was started. Final integration, acceptance
criteria, and the comparison of golden output were checked by the primary agent.

## Boundaries and remaining observations

- The emitted DSP and shared-memory transport have fixed memory and bounded
  work. `postMessage` delivery/recycling/control traffic can allocate and cause
  GC; it is outside an allocation-free/GC-free guarantee.
- Declared payload retention costs memory. A default typed ring reserves 16 MiB
  in WASM, with additional transport copies. Select a per-message byte budget
  and queue capacity appropriate to the application. Oversized typed content
  is clamped to that per-message budget.
- Chromium 148.0.7778.96 on this Mac is the browser tested here. Firefox/Safari,
  physical MIDI hardware, and this user's audio-device/listening judgment are
  not claimed as verified.
- The guide-only Vite dev server performed dependency optimization and reloaded
  during its first audio start. Starting after optimization passed the live
  checks. No suppression of Vite's cold-start reload is included in this batch.
- Vite's optional DevTools peer range warns against the guide's 0.4.x host. Its
  setup and production build pass; the complete authenticated DevTools UI is not
  certified by this acceptance. The demo build also retains its bundle-size and
  Binaryen externalization warnings.

The listening procedure and migration summary are in
[RELEASE-CANDIDATE.md](./RELEASE-CANDIDATE.md). The owner receives the isolated
consumer, package tarballs, raw check logs, coverage summaries, and sustained-run
receipts as a local verification bundle. Publication requires separate approval.
