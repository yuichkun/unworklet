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

## Cross-realm differential matrix

`packages/core/src/__tests__/browser/crossrealm.test.ts` compares real Chromium
AudioWorklet execution with Node `renderOffline` for the same saw, stereo gain,
and stateful input/event processors at the plugin’s baked 48 kHz rate. Both SAB and postMessage
projects execute the matrix; the fallback wrapper imports the common assertions.
Vitest browser commands run the offline oracle in Node, without bundling its
compiler or WAV dependencies into the browser.

Each case compares all 512 PCM samples per output channel by Float32 bit pattern,
the complete ordered event list (block-local sample offsets, scalar values and
typed-array contents), and snapshot identity plus every persistent slot byte.
Snapshot comparison uses decoded full buffers, not the truncated inspection
preview. The stateful fixture emits one distinguishable frame per quantum.
The context suspends after each quantum so transport delivery is drained before
continuing; the fourth suspension captures state at exactly the compared boundary.
An extra unobserved quantum lets the context finish after that snapshot.

The stereo automation row schedules gain values 0.5, 0.25, 1, 0 and 2 at times
0/48000, 64/48000, 128/48000, 255/48000 and 384/48000 seconds. A framework-free
ConstantSourceNode (value 1) through a native GainNode receives the same schedule
in the same context and render as the worklet. A third output channel captures
that native parameter vector; only this independent channel supplies the offline
renderer's per-sample gain. The two worklet output channels never supply an
expected value. Every worklet PCM bit and persistent snapshot byte is compared.
This controls for the host's seconds-to-sample quantization; it does not establish
that quantization is correct or promise all floating-point time boundaries.

Independent Node piecewise expectations cover both the authored sample vector
and a separately supplied literal vector. Negative controls alter raw native and
offline PCM before projection, modeling a one-sample late first transition and
holding that transition until the next quantum. The sample-255 seconds-to-frame
difference is characterized by the framework-free native control in
[PR #166](https://github.com/yuichkun/unworklet/pull/166).

The Node oracle tests independently pin stereo/stateful PCM and complete event and
state values at 44.1 and 48 kHz. Negative controls mutate raw PCM, events and decoded state before the observation
projection, then require the same exact equality assertion to
reject a one-bit PCM error, a missing/reordered/mistimed/corrupted event, a changed
state scalar and a changed byte beyond the snapshot preview. The existing saw
range/reference and repeated-render checks remain separate witnesses.

This is a bounded renderer/transport comparison using shared compiler code, not
an independent compiler proof. It covers static params, audio inputs, and one bounded a-rate step schedule, not all
processors, scheduled messages/MIDI, other automation curves, snapshot restore/migration,
other native sample rates (the plugin artifact rejects mismatches), real-time
contention, deadlines or other browsers.

## Generic event/message wire differential

`packages/offline/src/event-wire-differential.test.ts` owns a bounded Node
comparison of literal wire bytes, compiled-WASM dispatch/emission, and public
`renderOffline` injection/draining. A separate drop-oldest FIFO predicts retained
packets and overflow counts; expected slot/content bytes use literal offsets and
DataView writes, without production codecs or ring helpers. Ingress observations
are persistent state rows, separate from egress, so reciprocal encode/decode
mistakes cannot cancel.

The corpus covers inbound f32 scalar/array fields and outbound f32/i32/bool
scalars with one f32, u8 or f64 array, including sealed field order, later emit-site
reordering, aligned payload chunks, full payload contents and retention after
reuse. Six quanta exercise empty, exactly full, overflow, drain and refill at
capacity 16. Seeds cross signed/unsigned 32-bit boundaries while filling,
and cross head and tail separately on drop-oldest pushes.
Only meaningful payload bytes are asserted; unused chunk padding is excluded.
The offline package's existing native coverage job owns this suite.

This is not general serialization or concurrency proof: multiple variable fields,
other inbound element types, oversized/clipped payloads, malformed wire input,
concurrent publishers, real-browser transport, all capacities and MIDI/sysex
remain outside this corpus.

## Consolidation policy

The five package coverage jobs own their ordinary Node assertions once per Test workflow.
The residual CI project owns SAB, postMessage, native HMR and repository guards.
It also retains the DevTools UI assertions under the required aggregate check,
because the separate UI coverage check is not a required repository rule.
The MIDI property project intentionally retains an extra uninstrumented sample.
Demo, compatibility, packaging and soak workflows keep their own environments and
frequencies. Consolidating product-test execution does not remove product test source,
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

Each `Branch coverage (...)` check starts independently and is normally cancellable.
Lang executes four native file shards on independent runners, two workers each.
Its required owner validates current-attempt producer success and complete artifact
identity before native report merge enforces the full 98% threshold. A partial
shard or a skipped dependent job cannot substitute for this gate. Other package
coverage uses two workers and DevTools one. See the
[lang coverage guard](../scripts/lang-coverage/README.md) for failure and retry semantics.

Timing reports distinguish whole-workflow elapsed time (including queue/setup
and its slowest required work), individual test time, and summed runner job time.
More parallel workers can reduce waiting without reducing CPU work. Compare
matching source/test inventories, toolchain and execution contexts; keep push
HEAD and pull-request merge-tree results separate and disclose runner variance.

## Known limits

The portfolio does not yet establish every desired guarantee. The bounded matrix
above addresses layer D in [#14](https://github.com/yuichkun/unworklet/issues/14);
the generic event/message corpus above addresses part of layer C. Remaining
ring/wire cases and debug self-check work stay open. Track
real-time CPU/deadline/xrun budgets in [#24](https://github.com/yuichkun/unworklet/issues/24),
and deterministic MIDI boundaries and missing semantic assertions in
[#31](https://github.com/yuichkun/unworklet/issues/31).

A finite/bounded scrubbed output does not by itself prove zero scrubbing. A
payload length or nonempty event prefix does not establish exact contents or
sample timing. Parent V8 coverage excludes spawned CLI and AudioWorklet realms.
Chromium success is not Safari/Firefox proof. Keep these limits visible rather
than declaring them covered by a faster suite.
