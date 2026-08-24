/**
 * Behavior of the static-analysis stage (= `03-compiler.md` §3,
 * the first internal module of the Q-D stage plan).
 *
 * Phase 3 = noop = returns `[]` only (= Layer 3 checks in the layered error
 * model are filled by subsequent phases; plan specifies "analyze is Phase 3 = noop").
 */

import { expect, test } from "vite-plus/test";

import { analyze, checkMemoryBudget } from "./analyze.ts";
import type { CapturedGraph } from "./ast.ts";

const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

test("checkMemoryBudget: under 64 MiB produces no diagnostic", () => {
  expect(checkMemoryBudget(0)).toEqual([]);
  expect(checkMemoryBudget(64 * MIB)).toEqual([]);
  expect(checkMemoryBudget(10 * MIB)).toEqual([]);
});

test("checkMemoryBudget: over 64 MiB produces a warning (not an error)", () => {
  const diags = checkMemoryBudget(64 * MIB + 1);
  expect(diags).toHaveLength(1);
  expect(diags[0]!.id).toBe("memory-budget");
  expect(diags[0]!.severity).toBe("warning");
});

test("checkMemoryBudget: over the 4 GiB WASM32 ceiling produces an error", () => {
  const diags = checkMemoryBudget(4 * GIB + 1);
  expect(diags).toHaveLength(1);
  expect(diags[0]!.id).toBe("memory-budget");
  expect(diags[0]!.severity).toBe("error");
});

const emptyGraph: CapturedGraph = { declarations: [], statements: [] };

const populatedGraph: CapturedGraph = {
  declarations: [
    { kind: "audioInput", name: "main", channels: 2 },
    { kind: "audioOutput", name: "main", channels: 2 },
    {
      kind: "param",
      name: "gain",
      type: "f32",
      default: 1,
      min: 0,
      max: 4,
      automationRate: "a-rate",
    },
  ],
  statements: [{ kind: "forSample", stride: 1, body: [] }],
};

test("`analyze(emptyGraph)` returns an empty diagnostics array", () => {
  expect(analyze(emptyGraph)).toEqual([]);
});

test("`analyze(populatedGraph)` returns an empty diagnostics array (= Phase 3 noop)", () => {
  expect(analyze(populatedGraph)).toEqual([]);
});

// ─────────────────────────────────────────────────────────────────────────
// Q32-c: constant-truthy `emitIf` inside `forSample` = static-analysis error
// (`01-dsl.md` §4.1 + `decisions-log.md` Q32-c). stable ID = `constant-truthy-emitif`.
// ─────────────────────────────────────────────────────────────────────────

const constantTruthyEmitInForSample: CapturedGraph = {
  declarations: [
    {
      kind: "event",
      name: "peak",
      capacity: 256,
      payloadCapacity: undefined,
      fields: [{ name: "level", wireType: "f32" }],
    },
  ],
  statements: [
    {
      kind: "forSample",
      stride: 1,
      body: [
        {
          kind: "eventEmitIf",
          name: "peak",
          cond: { kind: "literal", type: "i32", value: 1 }, // truthy literal
          atSample: { kind: "loopCounter" },
          fields: [
            {
              name: "level",
              wireType: "f32",
              value: { kind: "literal", type: "f32", value: 0.5 },
            },
          ],
        },
      ],
    },
  ],
};

test("`analyze`: constant-truthy cond literal inside forSample produces an error diagnostic with a stable ID", () => {
  const diags = analyze(constantTruthyEmitInForSample);
  expect(diags).toHaveLength(1);
  expect(diags[0]).toMatchObject({
    id: "constant-truthy-emitif",
    severity: "error",
  });
  expect(diags[0]!.message).toMatch(/peak/);
});

// MIDI emit shares the same ringbuffer-saturation hazard: `midiOut.emitIf(true,
// ...)` at sample rate fills the MIDI ring in milliseconds, so `midiEmitIf` must
// be subject to the same constant-truthy guard as `event`.
const constantTruthyMidiEmitInForSample: CapturedGraph = {
  declarations: [{ kind: "midiOutput", name: "out", capacity: 256 }],
  statements: [
    {
      kind: "forSample",
      stride: 1,
      body: [
        {
          kind: "midiEmitIf",
          port: "out",
          eventType: "noteOn",
          cond: { kind: "literal", type: "i32", value: 1 }, // truthy literal
          atSample: { kind: "loopCounter" },
          channel: { kind: "literal", type: "i32", value: 0 },
          arg1: { kind: "literal", type: "i32", value: 60 },
          arg2: { kind: "literal", type: "i32", value: 100 },
        },
      ],
    },
  ],
};

test("`analyze`: constant-truthy midiEmitIf cond literal inside forSample produces an error with a stable ID", () => {
  const diags = analyze(constantTruthyMidiEmitInForSample);
  expect(diags).toHaveLength(1);
  expect(diags[0]).toMatchObject({
    id: "constant-truthy-emitif",
    severity: "error",
  });
  expect(diags[0]!.message).toMatch(/out/);
});

test("`analyze`: constant-truthy midiEmitIf cond literal at per-block top level produces no error", () => {
  // A `midiEmitIf(true)` outside `forSample` (= handler / per-block top) is the
  // canonical 1:1 projection form and must not be rejected.
  const graph: CapturedGraph = {
    declarations: [{ kind: "midiOutput", name: "out", capacity: 256 }],
    statements: [
      {
        kind: "midiEmitIf",
        port: "out",
        eventType: "noteOn",
        cond: { kind: "literal", type: "i32", value: 1 },
        atSample: { kind: "literal", type: "i32", value: 0 },
        channel: { kind: "literal", type: "i32", value: 0 },
        arg1: { kind: "literal", type: "i32", value: 60 },
        arg2: { kind: "literal", type: "i32", value: 100 },
      },
    ],
  };
  expect(analyze(graph)).toEqual([]);
});

test("`analyze`: falsy (= 0) cond literal inside forSample produces no error", () => {
  // A falsy literal is normally folded away at graph-capture time, but even if
  // it survives to the AST, analyze must not error — unconditional "never fires"
  // cannot saturate the ringbuffer, so it is not a violation.
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "event",
        name: "peak",
        capacity: 256,
        payloadCapacity: undefined,
        fields: [{ name: "level", wireType: "f32" }],
      },
    ],
    statements: [
      {
        kind: "forSample",
        stride: 1,
        body: [
          {
            kind: "eventEmitIf",
            name: "peak",
            cond: { kind: "literal", type: "i32", value: 0 },
            atSample: { kind: "loopCounter" },
            fields: [
              {
                name: "level",
                wireType: "f32",
                value: { kind: "literal", type: "f32", value: 0.5 },
              },
            ],
          },
        ],
      },
    ],
  };
  expect(analyze(graph)).toEqual([]);
});

test("`analyze`: constant-truthy cond literal at per-block top level produces no error (canonical spelling)", () => {
  // `emitIf(true, payload)` at handler context / per-block top level is canonical
  // unconditional emission and must be accepted. The error is forSample-scoped only.
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "event",
        name: "peak",
        capacity: 256,
        payloadCapacity: undefined,
        fields: [{ name: "level", wireType: "f32" }],
      },
    ],
    statements: [
      {
        kind: "eventEmitIf",
        name: "peak",
        cond: { kind: "literal", type: "i32", value: 1 },
        atSample: { kind: "literal", type: "i32", value: 0 },
        fields: [
          {
            name: "level",
            wireType: "f32",
            value: { kind: "literal", type: "f32", value: 0.5 },
          },
        ],
      },
    ],
  };
  expect(analyze(graph)).toEqual([]);
});

test("`analyze`: non-literal cond (= stateLoad) inside forSample produces no error", () => {
  // A state-edge-gated cond is dynamic and must be accepted. Only a constant-truthy
  // literal inside forSample is rejected.
  const graph: CapturedGraph = {
    declarations: [
      { kind: "state", name: "gate", type: "bool", initial: false, userNamed: true },
      {
        kind: "event",
        name: "peak",
        capacity: 256,
        payloadCapacity: undefined,
        fields: [{ name: "level", wireType: "f32" }],
      },
    ],
    statements: [
      {
        kind: "forSample",
        stride: 1,
        body: [
          {
            kind: "eventEmitIf",
            name: "peak",
            cond: { kind: "stateLoad", type: "bool", name: "gate" },
            atSample: { kind: "loopCounter" },
            fields: [
              {
                name: "level",
                wireType: "f32",
                value: { kind: "literal", type: "f32", value: 0.5 },
              },
            ],
          },
        ],
      },
    ],
  };
  expect(analyze(graph)).toEqual([]);
});

test("`analyze`: scans all emits inside forSample and reports every violation", () => {
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "event",
        name: "a",
        capacity: 256,
        payloadCapacity: undefined,
        fields: [],
      },
      {
        kind: "event",
        name: "b",
        capacity: 256,
        payloadCapacity: undefined,
        fields: [],
      },
    ],
    statements: [
      {
        kind: "forSample",
        stride: 1,
        body: [
          {
            kind: "eventEmitIf",
            name: "a",
            cond: { kind: "literal", type: "i32", value: 1 },
            atSample: { kind: "loopCounter" },
            fields: [],
          },
          {
            kind: "eventEmitIf",
            name: "b",
            cond: { kind: "literal", type: "i32", value: 1 },
            atSample: { kind: "loopCounter" },
            fields: [],
          },
        ],
      },
    ],
  };
  const diags = analyze(graph);
  expect(diags).toHaveLength(2);
  expect(diags.every((d) => d.id === "constant-truthy-emitif")).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────
// Type walk: after multi-type lowering, i32 / f64 / i64 arithmetic is valid
// (the former non-f32-arithmetic guard has been removed). walkForTypeErrors
// rejects only select branches with mismatched types. That multi-type arithmetic
// passes compilation is covered as a black-box behavioral guarantee by
// `__tests__/behavior/multitype.test.ts`.
// ─────────────────────────────────────────────────────────────────────────

test("`analyze` returns no diagnostics for a valid f32 graph walked end-to-end", () => {
  const graph: CapturedGraph = {
    declarations: [
      { kind: "audioInput", name: "main", channels: 1 },
      { kind: "audioOutput", name: "main", channels: 1 },
      {
        kind: "param",
        name: "gain",
        type: "f32",
        default: 1,
        min: 0,
        max: 4,
        automationRate: "a-rate",
      },
    ],
    statements: [
      {
        kind: "forSample",
        stride: 1,
        body: [
          {
            kind: "audioOutWrite",
            portName: "main",
            channel: 0,
            offset: { kind: "loopCounter" },
            value: {
              kind: "mul",
              type: "f32",
              lhs: {
                kind: "audioInRead",
                portName: "main",
                channel: 0,
                offset: { kind: "loopCounter" },
              },
              rhs: { kind: "paramAt", paramName: "gain", offset: { kind: "loopCounter" } },
            },
          },
        ],
      },
    ],
  };
  expect(analyze(graph)).toEqual([]);
});

test("`analyze` flags select with mismatched branch types as select-branch-type-mismatch", () => {
  const graph: CapturedGraph = {
    declarations: [{ kind: "state", name: "x", type: "i32", initial: 0 }],
    statements: [
      {
        kind: "stateStore",
        type: "i32",
        name: "x",
        value: {
          kind: "select",
          type: "i32",
          cond: { kind: "literal", type: "i32", value: 1 },
          ifTrue: { kind: "stateLoad", type: "i32", name: "x" },
          ifFalse: { kind: "literal", type: "f32", value: 5 },
        },
      },
    ],
  };
  expect(analyze(graph).some((d) => d.id === "select-branch-type-mismatch")).toBe(true);
});

test("`analyze` does NOT flag select with matching f32 branches", () => {
  const graph: CapturedGraph = {
    declarations: [{ kind: "audioOutput", name: "main", channels: 1 }],
    statements: [
      {
        kind: "audioOutWrite",
        portName: "main",
        channel: 0,
        offset: { kind: "literal", type: "i32", value: 0 },
        value: {
          kind: "select",
          type: "f32",
          cond: { kind: "literal", type: "i32", value: 1 },
          ifTrue: { kind: "literal", type: "f32", value: 1 },
          ifFalse: { kind: "literal", type: "f32", value: 0 },
        },
      },
    ],
  };
  expect(analyze(graph).some((d) => d.id === "select-branch-type-mismatch")).toBe(false);
});

test("`analyze`: a buffer declaration carrying publish is rejected (backstop for hand-built graphs, issue #38)", () => {
  // The declaration factories already throw at capture; a graph built by hand
  // (or by external tooling) bypasses them, so analyze re-checks — the publish
  // pipeline is scalar-only and a published buffer would silently never reach
  // `node.state`.
  const graph: CapturedGraph = {
    declarations: [
      { kind: "audioOutput", name: "main", channels: 1 },
      {
        kind: "buffer",
        name: "scope",
        type: "f32",
        size: 8,
        userNamed: true,
        publish: { rateFps: 30 },
      } as never,
    ],
    statements: [],
  };
  const diags = analyze(graph);
  expect(diags.some((d) => d.id === "buffer-publish-unsupported" && d.severity === "error")).toBe(
    true,
  );
});

test("`analyze`: a SIMD lane op on a buffer holding fewer than four elements is rejected (backstop for hand-built graphs)", () => {
  // A lane window spans 4 elements, so a 2-element buffer has no in-bounds
  // offset — the emitted clamp saturates into an empty range and the 16-byte
  // access still crosses into the next region.
  const graph: CapturedGraph = {
    declarations: [
      { kind: "audioOutput", name: "main", channels: 1 },
      { kind: "buffer", name: "tiny", type: "f32", size: 2, userNamed: true } as never,
    ],
    statements: [
      {
        kind: "forSample",
        body: [
          {
            kind: "bufferStoreVec",
            name: "tiny",
            offset: { kind: "loopCounter" },
            value: { kind: "vecSplat", value: { kind: "literal", type: "f32", value: 1 } },
          },
        ],
      } as never,
    ],
  };
  const diags = analyze(graph);
  expect(diags.some((d) => d.id === "simd-buffer-too-small" && d.severity === "error")).toBe(true);
});

test("`analyze`: a SIMD lane op nested in a MIDI handler body is reached by the buffer-window check", () => {
  // Handler bodies are a separate statement list; a walker that only descends
  // into forSample would pass this graph through to emit.
  const graph: CapturedGraph = {
    declarations: [
      { kind: "audioOutput", name: "main", channels: 1 },
      { kind: "buffer", name: "tiny", type: "f32", size: 3, userNamed: true } as never,
    ],
    statements: [
      {
        kind: "midiOnEvent",
        port: "in",
        eventType: "noteOn",
        body: [
          {
            kind: "bufferStoreVec",
            name: "tiny",
            offset: { kind: "literal", type: "i32", value: 0 },
            value: { kind: "vecSplat", value: { kind: "literal", type: "f32", value: 1 } },
          },
        ],
      } as never,
    ],
  };
  expect(analyze(graph).some((d) => d.id === "simd-buffer-too-small")).toBe(true);
});

test("`analyze`: a small buffer never touched by a SIMD lane op is accepted", () => {
  // The rule is about the access, not the declaration — scalar read/write on a
  // 2-element buffer is in bounds and stays legal.
  const graph: CapturedGraph = {
    declarations: [
      { kind: "audioOutput", name: "main", channels: 1 },
      { kind: "buffer", name: "tiny", type: "f32", size: 2, userNamed: true } as never,
    ],
    statements: [
      {
        kind: "forSample",
        body: [
          {
            kind: "bufferWrite",
            elementType: "f32",
            name: "tiny",
            index: { kind: "literal", type: "i32", value: 0 },
            value: { kind: "literal", type: "f32", value: 1 },
          },
        ],
      } as never,
    ],
  };
  expect(analyze(graph).some((d) => d.id === "simd-buffer-too-small")).toBe(false);
});

test("`analyze`: a sysex emit whose source buffer exceeds the content chunk is rejected at compile", () => {
  // The sysex content chunk holds perChunk-4 = 1020 payload bytes. A source
  // buffer.u8 bigger than that could never ship whole — truncating at emit
  // would deliver a corrupt sysex (no 0xF7 terminator), so the mismatch is a
  // build error, not a runtime surprise.
  const graph: CapturedGraph = {
    declarations: [
      { kind: "audioOutput", name: "main", channels: 1 },
      { kind: "midiOutput", name: "mo", capacity: 256 },
      { kind: "buffer", name: "big", type: "u8", size: 2048, userNamed: true },
    ] as never[],
    statements: [
      {
        kind: "midiEmitIf",
        port: "mo",
        eventType: "sysex",
        cond: { kind: "stateLoad", name: "g", type: "bool" },
        sysexBufferName: "big",
        sysexLength: { kind: "literal", type: "i32", value: 2048 },
        fields: [],
      } as never,
    ],
  };
  const diags = analyze(graph);
  expect(diags.some((d) => d.id === "sysex-buffer-exceeds-chunk" && d.severity === "error")).toBe(
    true,
  );
});
