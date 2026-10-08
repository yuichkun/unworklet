# Issue 155: bounded real-time restore observation

Original evidence and initial diagnostic verification base:
`300194c6fa6a8266619ccd6bdb3a23926e669354`.
Execution target: main `f55e32d72f4cfd7545e557ad28282c3d35767da0` after PRs
157/161/162/163. The client, worklet, original snapshot test and frozen-counter
fixture, and both browser configurations are byte-identical between these bases.
The lockfile adds unplugin's magic-string dependency; Playwright is unchanged.
The merged unplugin self-check patch changes bundling internals, so source
identity alone does not establish an identical browser execution environment.
Do not merge or release these hooks as a fix or public tracing API.

## Question and evidence

The original real-time test's final zero-count assertion fails intermittently after
its second restore, suspend, and resume. The failure's actual frame and protocol
phase remain unknown. The controlled OfflineAudioContext result at frame 57728
already demonstrates count 128 following an acknowledged restore; it does not
identify the historical real-time failure's cause.

- [Controlled actual restore](https://github.com/yuichkun/unworklet/issues/155#issuecomment-6056967755)
- [Latest original real-time failure, PR 164](https://github.com/yuichkun/unworklet/issues/155#issuecomment-6058689646)
- [Prior passing/inconclusive main-only observation](https://github.com/yuichkun/unworklet/issues/155#issuecomment-6055391380)

## Measurement

Only the existing frozen-counter real-time test opts in, by registering its fresh
context before createNode. An internal processorOptions flag enables that node's
worklet recorder. Both existing SAB/postMessage test projects run the same test.
No AudioParam monkey patch, automation cancellation, native value override, DSP
suppression, commit delay, new restore await, fixture edit, or assertion change is
introduced. All original critical-path awaits, 48000 Hz request, 50/30 ms waits,
100 ms busy-loop deadline, native setters, and user-gesture resume are retained.

Main records currentTime, context state, request ID, current pending phase, and
native freeze getter immediately around the existing restore assignment loop and
at protocol sends/replies. Test markers bracket suspension/resumption and the two
native unfreeze assignments. Worklet records currentFrame, restore request ID,
protocol phase, actual WASM count, and the actual parameters.freeze first/last
values and array length immediately before/after WASM processing; the mirrored
WASM freeze value is also retained. Control handlers record count before/after
prepare and commit and on receipt of the barrier.

Recording uses preallocated Float64Arrays, nine numbers per row, bounded to 256
main rows and 2048 worklet rows (147456 bytes). Full buffers stop retaining rows
and increment dropped. There is no recorder allocation, logging, message egress,
waiting, or per-sample instrumentation in process(). All quanta are retained until
the bound, covering roughly 2.7 audio seconds at 48000 Hz when recording two rows
per quantum, less the protocol rows. This avoids guessing which suspend boundary
will matter, while retaining the first resumed quanta.

Only after the original assertions finish or fail, finally requests one worklet
buffer dump and logs RESTORE_BOUNDARY_TRACE JSON. Its separate 1000 ms flush
budget does not lengthen any original measurement deadline. A flush timeout is
reported as missing evidence and does not replace an original failed assertion.
Synchronous port failures and malformed replies become diagnostic error results;
listener cleanup is attempted and timer cleanup occurs on every settled path.
The complete dump/format/log path is isolated so its exceptions cannot replace
an assertion or skip the original cleanup.
The original cleanup follows the flush.

## Row schema

All row arrays are flat; split into groups of nine. `used` is the retained row
count; `dropped` must be zero for a complete trace. NaN serializes to JSON null,
meaning unavailable rather than zero.

Main columns: phase, restore request ID, currentTime (seconds), context state,
pending protocol phase, native freeze getter, unused, unused, unused.
Context states: 1 running, 2 suspended, 3 other. Pending phases: 0 queued, 1 prepare,
2 barrier, 3 commit. Test markers have no pending phase (null); their request ID
is the most recently observed restore ID (0 before any restore).

Main phases:

- 10 prepare send; 11 prepared reply
- 12 before native restore assignment; 13 after native restore assignment
- 14 barrier send; 17 barrier reply
- 15 commit send; 18 commit reply; 16 promise settlement path
- 40/41 initial suspend before/after
- 42 second restore call before; 43 subsequent suspend call before
- 44 suspension resolved; 45 crossing restore resolved / resume call before
- 46 resume resolved; 47 assertions exited / flush begins
- 48/49 unfreeze assignment before/after (twice); 50 initial resume resolved

Worklet columns: phase, restore request ID, currentFrame, protocol phase,
WASM count, native freeze first, native array length, native freeze last,
WASM freeze mirror first. Protocol phases: 0 no prepare yet, 1 prepared path,
2 barrier received, 3 commit path. It records received protocol state, not an
independent verdict that ordering was valid. Native values are unavailable in
port handlers and are not substituted with the main getter or WASM mirror.

Worklet phases: 20/21 prepare before/after, 22 barrier receipt, 23/24 commit
before/after, 30/31 before/after DSP. Control handlers use exact incoming request
IDs; process rows retain the last protocol request ID. Browser currentFrame is
required; -1 is an unavailable-clock sentinel used only by node-side tests.

## One-run plan (requires review before publication)

Use one isolated diagnostic branch execution of the unchanged existing Test
workflow/aggregate, retaining its normal suite context, both transports, required
gates, browser defaults, and original assertions. Do not add a PR that would
unnecessarily cause a second event run. Preserve full logs, exact diagnostic SHA,
base SHA, checkout SHA, browser launch/version evidence, and both trace JSONs.
Expect Playwright 1.60.0 / Chromium build1223 / Chrome148.0.7778.96; verify actual
runner output rather than inferring version solely from the lockfile.

No repeat-until-failure or repeat-until-green. One passing execution is a valid
inconclusive result; an unrelated job failure remains failed. No native-only or
controlled-offline matrix needs rerunning. No required test gate is removed,
skipped, made continue-on-error, or reinterpreted by this diagnostic.

Inspect only the first few quanta after second commit and the first resumed
quantum, but retain the complete bounded log for protocol/order reconstruction.
Compare main currentTime \* actual sampleRate to worklet currentFrame without
rounding away fractional products; the two clocks are observations in separate
realms, not a single synchronized wall clock. Suspension's resolved time and
resume's first process frame together delimit the boundary. Protocol message
request IDs and within-realm row order establish causality where timestamps alone
cannot.

- Valid prepare/barrier/commit sequence, commit-after count zero, then native
  k-rate array length1/value0 and count0→128 in that quantum: direct evidence of
  native stale input despite acknowledged state restore in this real-time run.
  It still does not independently prove a specific Chromium implementation cause.
- Missing/reordered/crossed protocol messages or an unexpected pending phase:
  investigate ordering, using actual reply kind and request ID as well as phase.
- Commit-after count nonzero, or count advancing while native freeze is one:
  investigate state application / parameter marshaling / DSP; do not call it the
  established native stale-zero signature.
- No reproduced zero-count failure, missing dump, truncated rows, absent frame,
  or an unexpected non-scalar parameter array: inconclusive for the original
  causal question. An unexpected array needs fuller sample capture before claiming
  every DSP sample had the same native value.

## Observer effects and verification limits

Extra main native getter/currentTime reads and numeric writes can change timing.
Worklet property accesses, conditional branches and bounded writes add CPU cost;
initial allocation/module shape can affect JIT/GC timing. No trace can prove the
instrumented schedule equals an earlier uninstrumented failure. Control-handler
logging reads WASM state only; it cannot see Chromium's internal control queue.
A passing trace does not clear earlier failures or establish any restore contract.
Node-side tests model parameter arrays and validate trace fidelity and plumbing;
they are not native Chromium reproduction evidence.

Focused verification: bounded buffer and explicit truncation/unknown tests,
ordered real worklet restore followed by a modeled stale input in both transports,
enabled main-side phase/setter plumbing in both transports, and existing client,
worklet, loopback and worklet-import-graph tests. Browser measurement and the full
required CI portfolio are intentionally pending review and the single run.
