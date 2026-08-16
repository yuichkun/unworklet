export const meta = {
  name: "adversarial-review",
  description:
    "unworklet コードベース全体の adversarial review (9 観点 fan-out → dedup → 独立 skeptic verify)",
  phases: [
    { title: "Review", detail: "9 観点で並列に全コードを adversarial review" },
    { title: "Verify", detail: "各 finding を独立 skeptic が REFUTE 試行で検証" },
  ],
};

// ── 事実 context のみ (評価バイアスを刷り込まない) ───────────────────────────
const CONTEXT = `
You are reviewing **unworklet**, a TypeScript library (a normal npm package for the web
platform: Web Audio + Web MIDI + WebAssembly). It lets developers write AudioWorklet DSP
declaratively in TypeScript; a build-time meta-program captures a graph and emits a
WebAssembly module (via binaryen) that runs on the audio thread.

Repository layout (read the ACTUAL source — do not trust comments or docs claims about
what the code does; verify against the code itself):
- packages/core/src/        — the framework: compile/ (capture, ast, analyze, layout, emit,
  schemaHash, index), dsl/ (declarations, loop, primitives, constants), worklet.ts
  (audio-thread namespace: initialize/process + SAB/postMessage ring transport + snapshot),
  client.ts (main thread: createNode + node surface), midiWire.ts, snapshot.ts,
  replaceProcessor.ts, types.ts, processor.ts
- packages/offline/src/     — renderOffline: a deterministic pure-JS WASM driver
- packages/test/src/        — @unworklet/test: vitest matchers + audio/midi test utilities
- skills/unworklet/         — how the library is documented to behave, for consumers' agents.
  Verified: its examples compile in CI and it is re-checked by building real projects from it.
  If code and this guide disagree, that is a real finding — but judge which side is wrong by
  the product direction (the invariants below), not by assuming the guide is right.
- docs/                     — history ONLY: decisions-log.md (why each design question was
  settled) and RFCs. It does not describe current behaviour and is not a contract. Do not
  raise "code differs from docs" as a finding; there is no spec to differ from. The
  design-time spec chapters were deleted once the implementation shipped and was verified.

Hard invariants the codebase claims to uphold (verify they actually hold — do NOT assume
they do):
- Audio thread (worklet process() and emitted WASM) must be allocation-free, lock-free,
  GC-free, and bounded-loop only. Allocations/unbounded work per
  render quantum are realtime-safety bugs.
- Ring buffer header is [head:i32, tail:i32, overflowCount:i32] then a fixed-size slot
  array; pointers are slot-indexed; overflow policy is drop-oldest + monotonic counter.
- The MIDI wire slot is 8 bytes [status:u8, data1:u8, data2:u8, _pad:u8, atSample:u32-LE].
- Snapshot blobs are persisted by users and must survive via schemaHash + migration chain.

CRITICAL — review honestly and objectively. Do NOT assume the code is correct or
"already verified". Assume it may be broken and try to prove it. Ground EVERY finding in
the actual code with file:line. No speculation — if you assert a bug, you must have read
the code path and be able to explain the concrete failure. Read whole files for the areas
you assess (not just grep hits) so you judge in context. Look across the WHOLE codebase,
not any recent diff.`;

const FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", description: "One-line summary of the issue" },
          file: {
            type: "string",
            description: "Repo-relative path, e.g. packages/core/src/worklet.ts",
          },
          line: { type: "string", description: 'Line number or range, or "" if not line-specific' },
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          description: { type: "string", description: "What the code does and what is wrong" },
          why_bug: {
            type: "string",
            description:
              "The concrete failure: input/condition that triggers it + observable wrong behavior",
          },
          suggested_fix: { type: "string", description: "Brief direction for a fix" },
        },
        required: ["title", "file", "line", "severity", "description", "why_bug", "suggested_fix"],
      },
    },
  },
  required: ["findings"],
};

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    is_real: {
      type: "boolean",
      description:
        "true only if you confirmed by reading the code that this is a genuine bug/violation",
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    severity_adjusted: { type: "string", enum: ["critical", "high", "medium", "low", "not-a-bug"] },
    reasoning: { type: "string", description: "Why real or why refuted — cite the code you read" },
  },
  required: ["is_real", "confidence", "severity_adjusted", "reasoning"],
};

const DIMENSIONS = [
  {
    key: "realtime-safety",
    focus: `Realtime-safety on the audio thread. Inspect worklet.ts process()
and the per-quantum hot path, and the WASM emitted by compile/emit.ts. Hunt for: per-quantum
heap allocation (new Float32Array/DataView/Uint8Array/object/array inside process() or its
callees), unbounded loops driven by external input, anything that could trigger GC, and views
re-bound per quantum. Also check the postMessage drain loops and MIDI/event/message inject for
per-quantum allocation. A new typed-array or object created on every render quantum is a bug.`,
  },
  {
    key: "memory-layout",
    focus: `Memory layout + offset arithmetic. Inspect compile/layout.ts (region packing, base
offsets, sizes) and compile/emit.ts (load/store offsets, ring slot addressing, content regions).
Hunt for: off-by-one, region overlap, byte/element size confusion, alignment issues,
out-of-bounds access, capacity vs byte-length mixups, header (12 bytes) vs slot base errors,
sysex chunk indexing. Cross-check layout sizing against emit's accesses and against
worklet.ts/client.ts view bindings.`,
  },
  {
    key: "concurrency-sab",
    focus: `Concurrency / SharedArrayBuffer / Atomics correctness between main (client.ts) and
worklet (worklet.ts). Hunt for: missing or wrong acquire/release ordering (read head with
Atomics before reading slots; store slots before releasing head), torn reads, head/tail/overflow
accounting errors, drop-oldest logic, the main-side rAF poll vs worklet mirror, and block-atomic
snapshot/restore (does reading/writing linear memory in port.onmessage truly avoid mid-quantum
tears?). Compare the SAB path against the postMessage path for semantic divergence.`,
  },
  {
    key: "wire-format",
    focus: `Wire-format producer/consumer consistency. Inspect midiWire.ts, snapshot.ts (blob
codec + schemaHash + migration), and the event/message/MIDI slot encode/decode in worklet.ts,
client.ts, offline/index.ts. Hunt for: encode and decode disagreeing on byte layout/endianness/
field order, MIDI status-nibble round-trip errors (pitchBend 14-bit, channel mask, sysex 0xF0),
snapshot blob field framing, schemaHash collisions or instability, atSample u32 placement.
Verify the SAME format is used by every producer and consumer (main, worklet, offline).`,
  },
  {
    key: "graph-capture",
    focus: `Graph capture correctness. Inspect compile/capture.ts and compile/ast.ts. Focus on
the CSE / mutable-read freezing (issue #8): does reading a mutable slot (state.load / buffer.read
/ param.at / audioIn / payload field / midi field) get frozen at its lexical point so a later
store does not retroactively change an earlier read? Check tempAssign/tempRef. Hunt for: lazy
re-evaluation hazards, shared subgraph double-emit, statement ordering, loop-counter scoping,
handler-body capture.`,
  },
  {
    key: "type-contract",
    focus: `Type safety + public API contract. Inspect types.ts and the exported surface
(index.ts). Hunt for: discriminated unions with reachable unhandled variants, lift rules
(number/Node) with holes, unsound casts (as unknown as) that hide real mismatches, public
function signatures that contradict the documented surface, generic constraints that let wrong types through,
optional fields that should be required. Focus on places where a wrong type would compile but
fail at runtime.`,
  },
  {
    key: "test-integrity",
    focus: `Test integrity — detect "rigged"/八百長 tests. Inspect all *.test.ts across packages.
Hunt for: tests whose expected values were clearly copied from the implementation's output
rather than derived from first principles or a reference; assertions so weak they can't catch
regressions (toBeDefined, length>0 where exact values matter); tests that exercise mocks instead
of real behavior and thus prove nothing about production; missing abnormal/edge/boundary cases
the code clearly has branches for; round-trip tests that would pass even if both encode and
decode were wrong in a compensating way. Name specific tests + why they are weak.`,
  },
  {
    key: "lifecycle-resource",
    focus: `Resource lifecycle + leaks. Inspect client.ts (dispose, addEventListener/
removeEventListener pairing, rAF start/stop, subscriber sets, WeakMaps), replaceProcessor.ts,
worklet.ts. Hunt for: listeners added but not removed on dispose, rAF loops that never stop,
pending-request maps that leak on dispose/timeout (snapshot/restore promises that never
resolve), unbounded growth, double-dispose hazards, the replaceProcessor per-context counter.`,
  },
  {
    key: "error-edge",
    focus: `Error handling + edge cases. Across the codebase hunt for: unhandled abnormal inputs,
overflow/empty/zero-length/boundary (atSample 0 and 127, capacity boundaries, empty ring, empty
payload), NaN/Infinity propagation, WASM trap handling (no-trap saturation claims — verify),
sysex truncation, division by zero, integer wrap, missing validation on main-side send/restore,
silent failures that should surface via diagnostics/onError. Verify claimed "no-trap" paths
actually cannot trap.`,
  },
];

const reviewPrompt = (d) => `${CONTEXT}

YOUR REVIEW DIMENSION: ${d.key}
${d.focus}

Read the relevant source files in full (and skills/unworklet/ where the documented behaviour matters for your dimension). Produce a
list of concrete findings. Be thorough and exhaustive within your dimension — this is meant to
be a deep, adversarial audit, not a quick pass. Only report issues you can ground in specific
code (file:line) with a concrete failure mode. If you find nothing real in your dimension after
a genuine deep read, return an empty findings array rather than inventing weak findings.`;

const verifyPrompt = (f) => `${CONTEXT}

A reviewer reported the following finding. Your job is to ADVERSARIALLY VERIFY it: try to
REFUTE it. Read the actual code at the cited location and the surrounding context. Decide
whether it is a genuine bug/violation or a false positive (already handled elsewhere, spec
permits it, the reviewer misread, it is unreachable, or it is a deliberate documented choice).
Default toward skepticism: only mark is_real=true if you independently confirmed the failure by
reading the code. Adjust severity if the reviewer over/under-rated it.

FINDING:
- title: ${f.title}
- file: ${f.file}
- line: ${f.line}
- severity(claimed): ${f.severity}
- dimension: ${f.dimension}
- description: ${f.description}
- why_bug: ${f.why_bug}
- suggested_fix: ${f.suggested_fix}`;

phase("Review");
const reviews = await parallel(
  DIMENSIONS.map(
    (d) => () =>
      agent(reviewPrompt(d), {
        label: `review:${d.key}`,
        phase: "Review",
        schema: FINDINGS_SCHEMA,
        agentType: "general-purpose",
      }),
  ),
);

// Tag each finding with its dimension (index-aligned; do this BEFORE filtering nulls).
const allFindings = reviews.flatMap((r, i) =>
  r && Array.isArray(r.findings)
    ? r.findings.map((f) => ({ ...f, dimension: DIMENSIONS[i].key }))
    : [],
);

// Dedup across dimensions (same file+line+title prefix → one verification).
const seen = new Set();
const deduped = [];
for (const f of allFindings) {
  const key = `${f.file}::${f.line}::${(f.title || "").toLowerCase().slice(0, 50)}`;
  if (seen.has(key)) continue;
  seen.add(key);
  deduped.push(f);
}
log(
  `Review: ${allFindings.length} findings across ${DIMENSIONS.length} dimensions → ${deduped.length} after dedup`,
);

phase("Verify");
const verified = await parallel(
  deduped.map(
    (f) => () =>
      agent(verifyPrompt(f), {
        label: `verify:${f.dimension}:${(f.file || "").split("/").pop()}`,
        phase: "Verify",
        schema: VERDICT_SCHEMA,
        agentType: "general-purpose",
      }).then((v) => ({ ...f, verdict: v })),
  ),
);

const checked = verified.filter(Boolean);
const confirmed = checked.filter((f) => f.verdict && f.verdict.is_real);
log(`Verify: ${confirmed.length} confirmed real of ${checked.length} verified`);

// Sort confirmed by adjusted severity for triage.
const order = { critical: 0, high: 1, medium: 2, low: 3, "not-a-bug": 4 };
confirmed.sort(
  (a, b) => (order[a.verdict.severity_adjusted] ?? 9) - (order[b.verdict.severity_adjusted] ?? 9),
);

return {
  totalFindings: allFindings.length,
  dedupedFindings: deduped.length,
  confirmedCount: confirmed.length,
  confirmed,
  refuted: checked
    .filter((f) => !(f.verdict && f.verdict.is_real))
    .map((f) => ({
      title: f.title,
      file: f.file,
      line: f.line,
      dimension: f.dimension,
      reasoning: f.verdict ? f.verdict.reasoning : "no verdict",
    })),
};
