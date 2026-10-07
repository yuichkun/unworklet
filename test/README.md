# Test portfolio

Tests are assigned by the failure they detect, not by a target test count.
`vp test` remains the complete local workspace suite. CI runs package Node
assertions with their native V8 coverage gate and runs the remaining environments
through `vite.ci.config.ts`. Every package and DevTools UI must retain at least
98% branch coverage over its configured source inventory.

## Protected guarantees and ownership

| Owner / layer                     | Guarantee and representative source                                                                                                                | Why it stays at this layer                                                                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core, Node                        | Declaration bounds, namespaces, scalar types and illegal DSP operations: `packages/core/src/dsl/*.test.ts`                                         | Negative and boundary cases are not replaced by a successful synth example.                                                                                         |
| Core, Node compiler               | IR, capture, layout/alignment, schema identity and emission: `packages/core/src/compile/*.test.ts`                                                 | Structural failures can precede audible failures; diagnostics identify the broken compiler stage.                                                                   |
| Core, real WASM in Node           | Independent numerical/PCM, SIMD, state and payload semantics: `packages/core/src/__tests__/behavior/`                                              | This executes generated WASM. It is not a browser mock, and does not need native AudioWorklet scheduling.                                                           |
| Lang, Node/compiler/real WASM     | Classification, conservative rejection, lowering, sugar and generated-name hygiene: `packages/lang/src/**/*.test.ts`                               | Structural fingerprints and independent PCM oracles are complementary. A common emitter defect can make two fingerprints agree while PCM is wrong.                  |
| Lang, Node snapshot replay        | Disk versus captured filesystem and browser-source purity: `__sugar__/browser-mode.test.ts`, `browser-entry-purity.test.ts`                        | These tests deliberately run in Node. Their filenames do not imply native-browser coverage.                                                                         |
| Lang, filesystem and subprocesses | Module resolution/cleanup, CLI errors, IDE diagnostics, ambient declarations                                                                       | An in-memory evaluator cannot replace native module loading, cold startup or published CLI behavior.                                                                |
| Core, mocked host with real logic | Client lifecycle, retries, disposal, snapshot/replacement and worklet transport edge cases                                                         | Controlled host/port fixtures make malformed messages, pool exhaustion and race boundaries deterministic. They do not establish browser compatibility.              |
| Core, client/worklet loopback     | Real client, worklet and WASM wiring across both transports: `client-worklet-loopback.test.ts`                                                     | Preserves feedback/ownership and wrap behavior without pretending synchronous ports reproduce native clone/transfer scheduling.                                     |
| Core, protocol/model              | Ring arithmetic, signed wrap, contention and model-to-runtime binding: `ringIndex`, `sabIngress`, `concurrency`, `ring-protocol.conformance` tests | Rare boundaries and unsafe interleavings are unlikely in a browser smoke. Model exploration and real protocol conformance must both pass.                           |
| Core, property tests              | MIDI wire round trips and invalid/status boundaries: `midiWire.property.test.ts`                                                                   | CI retains both coverage execution and a separate uninstrumented invocation with fresh random sampling. One run is not silently substituted for two.                |
| Offline, real WASM/public API     | Sample counts, rates, scheduled events, snapshots, output health and cache isolation: `packages/offline/src/*.test.ts`                             | Public renderer wiring and repeated/concurrent-call isolation are distinct from core compiler semantics.                                                            |
| Audio utilities and anchors       | WAV/parser directions, matcher acceptance and rejection, frozen identities, documentation processors and demo sound goldens                        | A matcher must reject bad output as well as accept good output. Numeric and committed WAV oracles remain independent of graph agreement.                            |
| Unplugin, Node/build/filesystem   | Plugin hooks, actual builds, source discovery, revision identity and generated type witnesses                                                      | Build artifacts, teardown barriers, cold starts and language-service updates need their real boundaries.                                                            |
| Core, Chromium SAB                | AudioWorklet boot, native I/O/AudioParam, publish/subscriptions, lifecycle and snapshot/replacement                                                | Native API, scheduling and shared-memory behavior cannot be established by Node fixtures.                                                                           |
| Core, Chromium postMessage        | The same relevant browser contract without shared memory                                                                                           | Imported test bodies still execute in a different transport. Transfer ownership and allocation boundaries differ from SAB.                                          |
| Unplugin, Chromium/live audio     | HMR and transitive helper updates in a real AudioContext: `hmr.browser.test.ts`                                                                    | A pure revision hash test cannot catch native registration collisions or stale parameter descriptors.                                                               |
| DevTools, happy-dom               | Vue component/state semantics and UI branch coverage                                                                                               | Deterministic UI state tests belong here; this does not assert real focus, rendering or audio behavior.                                                             |
| Demo, Node and Chromium           | Runnable examples/WAV goldens; Monaco, worker, focus/undo/layout and browser compiler integration                                                  | Keep real browser interaction and consumer build boundaries. Do not infer full audio execution from a compiler Blob-byte assertion alone.                           |
| Typecheck and packaging           | Positive/negative source types, packed declarations, publint and arethetypeswrong                                                                  | Runtime behavior cannot prove public type acceptance/rejection or package export correctness.                                                                       |
| Compatibility workflows           | Packed Node 20 runtime and TypeScript 5.0.4/5.5.4/5.9.3 consumers                                                                                  | The same source test under a different supported runtime/compiler is not redundant execution.                                                                       |
| Repository and release guards     | Lockstep versions, build-cache soundness, sound-update safety, release soak evidence                                                               | These span packages or spawn intentional consumer/update checks; they do not belong to one package's branch gate.                                                   |
| Runtime and release soak          | Sustained transport, visibility and long-duration integrity                                                                                        | Functional correctness, bounded offline rendering and long-duration stability protect different failures. Execution durations and release evidence remain explicit. |

## Consolidation policy

The five package coverage jobs own their ordinary Node assertions once per Test workflow.
The residual CI project owns SAB, postMessage, native HMR and repository guards.
It also retains the DevTools UI assertions under the required aggregate check,
because the separate UI coverage check is not a required repository rule.
The MIDI property project intentionally retains an extra uninstrumented sample.
Demo, compatibility, packaging and soak workflows keep their own environments and
frequencies. Removing duplicate orchestration does not remove test source,
assertions, scalar boundaries, negative controls or a supported environment.

The portfolio collection guard compares the actual project configurations and
tracked tests. A newly added test must have a CI owner; project/transport identity
matters when different wrappers import common bodies. Local aggregate collection
must still describe the full workspace suite. Builds finish before concurrent
consumers; a test optimization must not repack shared `dist/` while another suite
is importing it.

Within a test, immutable lowered text may be reused only when the input is
identical. Processor evaluation, fingerprinting and real-WASM execution retain
fresh state. Dedicated repeated-call/cache/isolation tests must not have their
repetition consolidated away. Independent numerical expectations remain even
where graph/layout/schema assertions also exist.

No browser group is moved to Node merely because it is slower. Exhaustive policy
and malformed-input matrices can live in deterministic Node fixtures, while real
scheduling, native parameter descriptors, clone/transfer, lifecycle, HMR and UI
interaction remain in Chromium. A proposed move needs fault-detection evidence
for the specific assertion and its environment, not just similar test names.

## Gates and timing

Each `Branch coverage (...)` check is an ordinary dependency-free job. Lang uses
four native workers on the hosted Ubuntu runner; other package coverage uses two
and DevTools one. Native Vitest owns collection, failure propagation and the full
98% threshold. There is no partial-shard threshold or downstream skipped merger
that can stand in for a completed package gate. Cancellation is not a passing
coverage result.

Timing reports distinguish whole-workflow elapsed time (including queue/setup
and its slowest required work), individual test time, and summed runner job time.
More parallel workers can reduce waiting without reducing CPU work. Compare
matching source/test inventories, toolchain and execution contexts; keep push
HEAD and pull-request merge-tree results separate and disclose runner variance.

## Known limits

The portfolio does not yet establish every desired guarantee. Track the missing
online/offline PCM/event/snapshot matrix in [#14](https://github.com/yuichkun/unworklet/issues/14),
real-time CPU/deadline/xrun budgets in [#24](https://github.com/yuichkun/unworklet/issues/24),
and deterministic MIDI boundaries and missing semantic assertions in
[#31](https://github.com/yuichkun/unworklet/issues/31).

A finite/bounded scrubbed output does not by itself prove zero scrubbing. A
payload length or nonempty event prefix does not establish exact contents or
sample timing. Parent V8 coverage excludes spawned CLI and AudioWorklet realms.
Chromium success is not Safari/Firefox proof. Keep these limits visible rather
than declaring them covered by a faster suite.
