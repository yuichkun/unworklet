# v0.3.0 candidate validation

Status: **not ready for release**. The implementation is based on PR #48 at
`2f7706850b67b448c51746d3037c08436b50004f`, with local stabilization changes.
No remote update, merge, release tag, or package publication has been performed.

## Implemented

- Processor-file exports are rejected with shared-module migration guidance;
  library exports and imports remain usable. The export-hoist effect analysis
  is removed. Shared-module witnesses render the intended value in every sample.
- SIMD stores have a separate value temporary. Computed-offset regressions pass;
  the twelve golden fixtures change only their WASM hashes, with PCM, snapshot,
  graph, memory layout, and schema hashes preserved.
- SAB outbound event/MIDI publication and main snapshots use one-attempt
  ownership. Audio never waits for main. Callback reentrancy, disposal, errors,
  contention, typed content, sysex, and counter wrap are covered.
- Default-only processor exports produce valid generated modules. Named-only
  and named-plus-default exports remain valid.
- Fallback allocation/GC limits and processor export migration are documented.
  All five package manifests identify version 0.3.0; it is not published.
- CI contains explicit per-package branch-coverage jobs. These jobs have not
  been executed remotely for these local changes.
- Vite+ is a shared root development dependency. This keeps aggregated tests
  on one collector instead of loading identical runner code twice through
  different peer-dependency paths.

## Executed checks

Package coverage and consumer checks are separate invocations. The root
aggregation passes against the working tree; the final packaged artifacts have
not been verified.

| Check                                       | Result                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| core node tests + coverage                  | 1,076 tests pass; branches 2,406/2,455 = 98.00%                         |
| offline node tests + coverage               | 121 tests pass; branches 135/136 = 99.26%                               |
| test package + coverage                     | 230 tests pass; branches 277/278 = 99.64%                               |
| unplugin node tests + coverage              | 166 tests pass; branches 258/263 = 98.09%                               |
| lang full coverage                          | Stopped at the plan-amendment checkpoint; no pass or final percentage   |
| Chromium SAB suite                          | 9 files / 41 tests pass                                                 |
| Chromium postMessage suite                  | 6 files / 41 tests pass                                                 |
| demo offline suite                          | 14 tests pass                                                           |
| demo browser compilation suite              | 4 tests pass                                                            |
| release invariants / guide references       | 10 tests pass (including soak receipt validation)                       |
| real visibility preflight                   | 10-second requested duration, both transports pass                      |
| 30-minute run per transport                 | Not executed; release-blocking decisions pending                        |
| final packaging / isolated guide-only build | Pending                                                                 |
| complete root `vp check` and `vp test`      | Root check exits 0 (one existing warning); 144 files / 2,736 tests pass |

The Vite+ runner identifies itself as 0.1.24 and requests coverage provider 4.1.8
in its package metadata. Provider 4.1.8 is installed. Its version-comparison
warning remains visible; measurements are recorded without suppressing it.

Coverage improvements use behavioral tests and removal of unreachable internal
branches. The removals concern lookups derived from the same immutable layout
metadata and SAB-only code guarded by the presence of its shared view. External
snapshot, port-message, declared-width, and unknown-buffer checks remain.
Thresholds and coverage exclusions were not lowered.

The long lang coverage invocation was stopped cleanly when the additional
release-blocking decisions remained unresolved. Its partial coverage is not a
package result. The changed lang suites pass separately without coverage:
4 files / 145 tests.

The visibility preflight uses a dedicated temporary browser profile and CDP's
`noDefaults` connection option. It does not override `document.visibilityState`.
SAB ran for 10.517 audio seconds, postMessage for 11.248 audio seconds; both
observed hidden and visible states. Packet duplicates, reversals, corruption,
gaps, overflow, and reported errors were zero. A short preflight does not
substitute for the required full duration.

## Release blockers requiring the plan to be revisited

1. **Payload retention does not match declared ring capacity.** A capacity-1024
   event ring with typed content can retain seventeen slot headers while its
   sixteen payload chunks reuse the first payload. Both the PR base and the
   stabilization tree delivered `{ n: 0, data: 16 }` with overflow zero.
   The choice between allocating the requested retention and explicitly
   limiting/observing payload retention awaits the owner.
2. **Nested message-to-event emission can stop the processor.** A handler for
   one incoming message that emits an outgoing event overwrites the drain's
   temporary head value. Both base and stabilization compile successfully but
   do not return from `process()` in the bounded worker probe. A common
   temporary-lifetime design needs an approved scope amendment; no further
   one-off temporary patch has been applied.
3. **The opposite SAB direction also has an existing copy race.** Filling the
   main-to-worklet ring with 0–15, then sending 16 between the worklet's header
   read and slot copy, processes 16 twice. Both base and stabilization yield
   sums 136 then 152, instead of a final 136. The outbound ownership change
   does not protect inbound copies. The synchronous sender's contention
   behavior needs to be designed rather than silently dropping a send.

## Independent review

Round 1 is complete. It found the inbound race above and an inaccurate stale-temp
cleanup description, which is corrected. It did not find another regression in
the export restriction, SIMD store change, or outbound snapshot protection.
Round 2 has not been used. No recurring review automation has been started.

Full-duration, packaging, and guide-only acceptance must be repeated on the
candidate containing the approved blocker fixes. The listening procedure is in
[RELEASE-CANDIDATE.md](./RELEASE-CANDIDATE.md#listening-check).
