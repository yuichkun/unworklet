/**
 * Behavior of the WASM emission stage (one of the Q-D internal modules:
 * no arguments, fixed-region WASM exports).
 *
 * Dynamically imports binaryen, lowers AST to binaryen IR, and returns
 * a WASM binary. Two test layers:
 * - unit = invoke emitExpression / emitStatement directly, wrap in a
 *   binaryen module, and fix the full WAT via inline snapshots
 *   (regression check equivalent to schemaHash — intentional retract on
 *   binaryen version bump or lowering strategy change)
 * - e2e = emit -> WebAssembly.instantiate -> write inputs into memory ->
 *   call process() -> read outputs from memory and verify expected values
 */

import { expect, test } from "vite-plus/test";

import { unwrapAst } from "./capture.ts";
import { select } from "../dsl/primitives.ts";

import type { AstNode, CapturedGraph } from "./ast.ts";
import type { ScalarType } from "../types.ts";
import type { BinaryenAPI, BinaryenModule } from "./emit.ts";
import { emit, emitExpression, emitStatement } from "./emit.ts";
import { layout } from "./layout.ts";

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

const monoPassthroughGraph: CapturedGraph = {
  declarations: [
    { kind: "audioInput", name: "main", channels: 1 },
    { kind: "audioOutput", name: "main", channels: 1 },
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
            kind: "audioInRead",
            portName: "main",
            channel: 0,
            offset: { kind: "loopCounter" },
          },
        },
      ],
    },
  ],
};

const stereoGainGraph: CapturedGraph = {
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
        {
          kind: "audioOutWrite",
          portName: "main",
          channel: 1,
          offset: { kind: "loopCounter" },
          value: {
            kind: "mul",
            type: "f32",
            lhs: {
              kind: "audioInRead",
              portName: "main",
              channel: 1,
              offset: { kind: "loopCounter" },
            },
            rhs: { kind: "paramAt", paramName: "gain", offset: { kind: "loopCounter" } },
          },
        },
      ],
    },
  ],
};

const monoLiteralWriteGraph: CapturedGraph = {
  declarations: [{ kind: "audioOutput", name: "main", channels: 1 }],
  statements: [
    {
      kind: "audioOutWrite",
      portName: "main",
      channel: 0,
      offset: { kind: "literal", type: "i32", value: 0 },
      value: { kind: "literal", type: "f32", value: 0.5 },
    },
  ],
};

const emptyGraph: CapturedGraph = { declarations: [], statements: [] };

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

async function loadBinaryen(): Promise<BinaryenAPI> {
  return (await import("binaryen")).default;
}

function makeMod(binaryen: BinaryenAPI): BinaryenModule {
  const mod = new binaryen.Module();
  mod.setMemory(1, 1, "memory");
  return mod;
}

function watOfExpression(
  mod: BinaryenModule,
  binaryen: BinaryenAPI,
  ref: number,
  resultType: number,
): string {
  mod.addFunction("probe", binaryen.none, resultType, [binaryen.i32], ref);
  return mod.emitText();
}

function watOfStatement(mod: BinaryenModule, binaryen: BinaryenAPI, ref: number): string {
  mod.addFunction("probe", binaryen.none, binaryen.none, [binaryen.i32], ref);
  return mod.emitText();
}

async function instantiate(graph: CapturedGraph): Promise<{
  memory: WebAssembly.Memory;
  process: () => void;
}> {
  const lay = layout(graph);
  const wasm = await emit(graph, lay);
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  return {
    memory: instance.exports["memory"] as WebAssembly.Memory,
    process: instance.exports["process"] as () => void,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Unit tests: emitExpression / emitStatement intermediate IR (full WAT match)
// ─────────────────────────────────────────────────────────────────────────

const emptyLayout = layout({ declarations: [], statements: [] });

test("`emitExpression(literal f32)` lowers to the fixed WAT", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  const ref = emitExpression(
    { kind: "literal", type: "f32", value: 0.5 },
    emptyLayout,
    mod,
    binaryen,
  );
  expect(watOfExpression(mod, binaryen, ref, binaryen.f32)).toMatchInlineSnapshot(`
    "(module
     (type $0 (func (result f32)))
     (memory $0 1 1)
     (export "memory" (memory $0))
     (func $probe (result f32)
      (local $0 i32)
      (f32.const 0.5)
     )
    )
    "
  `);
  mod.dispose();
});

test("`emitExpression(literal i32)` lowers to the fixed WAT", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  const ref = emitExpression(
    { kind: "literal", type: "i32", value: 7 },
    emptyLayout,
    mod,
    binaryen,
  );
  expect(watOfExpression(mod, binaryen, ref, binaryen.i32)).toMatchInlineSnapshot(`
    "(module
     (type $0 (func (result i32)))
     (memory $0 1 1)
     (export "memory" (memory $0))
     (func $probe (result i32)
      (local $0 i32)
      (i32.const 7)
     )
    )
    "
  `);
  mod.dispose();
});

test("`emitExpression(loopCounter)` lowers to the fixed WAT", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  const ref = emitExpression({ kind: "loopCounter" }, emptyLayout, mod, binaryen);
  expect(watOfExpression(mod, binaryen, ref, binaryen.i32)).toMatchInlineSnapshot(`
    "(module
     (type $0 (func (result i32)))
     (memory $0 1 1)
     (export "memory" (memory $0))
     (func $probe (result i32)
      (local $0 i32)
      (local.get $0)
     )
    )
    "
  `);
  mod.dispose();
});

test("`emitExpression(mul)` lowers to the fixed WAT", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  const ref = emitExpression(
    {
      kind: "mul",
      type: "f32",
      lhs: { kind: "literal", type: "f32", value: 2 },
      rhs: { kind: "literal", type: "f32", value: 3 },
    },
    emptyLayout,
    mod,
    binaryen,
  );
  expect(watOfExpression(mod, binaryen, ref, binaryen.f32)).toMatchInlineSnapshot(`
    "(module
     (type $0 (func (result f32)))
     (memory $0 1 1)
     (export "memory" (memory $0))
     (func $probe (result f32)
      (local $0 i32)
      (f32.mul
       (f32.const 2)
       (f32.const 3)
      )
     )
    )
    "
  `);
  mod.dispose();
});

test("`emitExpression(abs)` lowers to `f32.abs`", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  const ref = emitExpression(
    {
      kind: "abs",
      type: "f32",
      value: { kind: "literal", type: "f32", value: -1.5 },
    },
    emptyLayout,
    mod,
    binaryen,
  );
  const wat = watOfExpression(mod, binaryen, ref, binaryen.f32);
  expect(wat).toContain("(f32.abs");
  expect(wat).toContain("(f32.const -1.5)");
  mod.dispose();
});

test("`emitExpression(max)` lowers to `f32.max`", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  const ref = emitExpression(
    {
      kind: "max",
      type: "f32",
      lhs: { kind: "literal", type: "f32", value: 0.3 },
      rhs: { kind: "literal", type: "f32", value: 0.8 },
    },
    emptyLayout,
    mod,
    binaryen,
  );
  expect(watOfExpression(mod, binaryen, ref, binaryen.f32)).toContain("(f32.max");
  mod.dispose();
});

test("`emit(abs + max)` e2e: peak detector — expected value = max(abs(in), state)", async () => {
  const graph: CapturedGraph = {
    declarations: [
      { kind: "audioInput", name: "main", channels: 1 },
      { kind: "state", name: "peak", type: "f32", initial: 0, userNamed: true },
    ],
    statements: [
      {
        kind: "forSample",
        stride: 1,
        body: [
          {
            kind: "stateStore",
            type: "f32",
            name: "peak",
            value: {
              kind: "max",
              type: "f32",
              lhs: {
                kind: "abs",
                type: "f32",
                value: {
                  kind: "audioInRead",
                  portName: "main",
                  channel: 0,
                  offset: { kind: "loopCounter" },
                },
              },
              rhs: { kind: "stateLoad", type: "f32", name: "peak" },
            },
          },
        ],
      },
    ],
  };
  const lay = layout(graph);
  const { memory, process } = await instantiate(graph);
  // input [-0.3, 0.5, -0.7, 0.2, ...] — peak via abs: max = 0.7
  const inputView = new Float32Array(memory.buffer, lay.regions.ioScratch.inputs["main"]!, 128);
  inputView[0] = -0.3;
  inputView[1] = 0.5;
  inputView[2] = -0.7;
  inputView[3] = 0.2;
  process();
  const peakView = new Float32Array(memory.buffer, lay.regions.states.slots["peak"]!, 1);
  expect(peakView[0]).toBeCloseTo(0.7, 5);
});

test("`emitExpression(audioInRead)` lowers to the fixed WAT", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  const lay = layout({
    declarations: [{ kind: "audioInput", name: "main", channels: 2 }],
    statements: [],
  });
  const ref = emitExpression(
    {
      kind: "audioInRead",
      portName: "main",
      channel: 1,
      offset: { kind: "literal", type: "i32", value: 4 },
    },
    lay,
    mod,
    binaryen,
  );
  expect(watOfExpression(mod, binaryen, ref, binaryen.f32)).toMatchInlineSnapshot(`
    "(module
     (type $0 (func (result f32)))
     (memory $0 1 1)
     (export "memory" (memory $0))
     (func $probe (result f32)
      (local $0 i32)
      (f32.load
       (i32.add
        (i32.const 512)
        (i32.mul
         (i32.const 4)
         (i32.const 4)
        )
       )
      )
     )
    )
    "
  `);
  mod.dispose();
});

test("`emitExpression(paramAt)` lowers to the fixed WAT", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  const lay = layout({
    declarations: [
      {
        kind: "param",
        name: "gain",
        type: "f32",
        default: 1,
        min: 0,
        max: 1,
        automationRate: "k-rate",
      },
    ],
    statements: [],
  });
  const ref = emitExpression(
    { kind: "paramAt", paramName: "gain", offset: { kind: "loopCounter" } },
    lay,
    mod,
    binaryen,
  );
  expect(watOfExpression(mod, binaryen, ref, binaryen.f32)).toMatchInlineSnapshot(`
    "(module
     (type $0 (func (result f32)))
     (memory $0 1 1)
     (export "memory" (memory $0))
     (func $probe (result f32)
      (local $0 i32)
      (f32.load
       (i32.add
        (i32.const 0)
        (i32.mul
         (local.get $0)
         (i32.const 4)
        )
       )
      )
     )
    )
    "
  `);
  mod.dispose();
});

test("`emitStatement(audioOutWrite)` lowers to the fixed WAT", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  const lay = layout({
    declarations: [{ kind: "audioOutput", name: "main", channels: 1 }],
    statements: [],
  });
  const ref = emitStatement(
    {
      kind: "audioOutWrite",
      portName: "main",
      channel: 0,
      offset: { kind: "literal", type: "i32", value: 0 },
      value: { kind: "literal", type: "f32", value: 0.25 },
    },
    lay,
    mod,
    binaryen,
  );
  expect(watOfStatement(mod, binaryen, ref)).toMatchInlineSnapshot(`
    "(module
     (type $0 (func))
     (memory $0 1 1)
     (export "memory" (memory $0))
     (func $probe
      (local $0 i32)
      (f32.store
       (i32.add
        (i32.const 0)
        (i32.mul
         (i32.const 0)
         (i32.const 4)
        )
       )
       (f32.const 0.25)
      )
     )
    )
    "
  `);
  mod.dispose();
});

test("`emitStatement(forSample)` lowers to the fixed WAT", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  const ref = emitStatement({ kind: "forSample", stride: 1, body: [] }, emptyLayout, mod, binaryen);
  expect(watOfStatement(mod, binaryen, ref)).toMatchInlineSnapshot(`
    "(module
     (type $0 (func))
     (memory $0 1 1)
     (export "memory" (memory $0))
     (func $probe
      (local $0 i32)
      (local.set $0
       (i32.const 0)
      )
      (block $break
       (loop $continue
        (br_if $break
         (i32.ge_s
          (local.get $0)
          (i32.const 128)
         )
        )
        (local.set $0
         (i32.add
          (local.get $0)
          (i32.const 1)
         )
        )
        (br $continue)
       )
      )
     )
    )
    "
  `);
  mod.dispose();
});

// ─────────────────────────────────────────────────────────────────────────
// E2E tests: emit -> WebAssembly.compile -> instantiate -> memory I/O
// ─────────────────────────────────────────────────────────────────────────

test("`emit(emptyGraph, emptyLayout)` returns valid WASM bytes (= Uint8Array)", async () => {
  const wasm = await emit(emptyGraph, layout(emptyGraph));
  expect(wasm).toBeInstanceOf(Uint8Array);
  expect(wasm.byteLength).toBeGreaterThan(0);
});

test("`emit(emptyGraph)` produces a no-op `process` that runs cleanly", async () => {
  const { process } = await instantiate(emptyGraph);
  expect(() => process()).not.toThrow();
});

test("`emit(monoLiteralWrite)` = top-level literal write is reflected in memory (1 sample)", async () => {
  const lay = layout(monoLiteralWriteGraph);
  const { memory, process } = await instantiate(monoLiteralWriteGraph);
  process();
  const out = new Float32Array(memory.buffer, lay.regions.ioScratch.outputs["main"]!, 128);
  expect(out[0]).toBe(0.5);
  expect(out[1]).toBe(0); // remaining samples are zero
});

test("`emit(monoPassthrough)` = input is copied directly to output", async () => {
  const lay = layout(monoPassthroughGraph);
  const { memory, process } = await instantiate(monoPassthroughGraph);
  const input = new Float32Array(memory.buffer, lay.regions.ioScratch.inputs["main"]!, 128);
  for (let i = 0; i < 128; i++) {
    input[i] = i * 0.01;
  }
  process();
  const out = new Float32Array(memory.buffer, lay.regions.ioScratch.outputs["main"]!, 128);
  for (let i = 0; i < 128; i++) {
    expect(out[i]).toBeCloseTo(i * 0.01, 6);
  }
});

test("`emit(stereoGain)` = (input * gain) is written per channel to output", async () => {
  const lay = layout(stereoGainGraph);
  const { memory, process } = await instantiate(stereoGainGraph);
  const inputCh0 = new Float32Array(memory.buffer, lay.regions.ioScratch.inputs["main"]!, 128);
  const inputCh1 = new Float32Array(
    memory.buffer,
    lay.regions.ioScratch.inputs["main"]! + 128 * 4,
    128,
  );
  inputCh0.fill(1.0);
  inputCh1.fill(0.25);
  const gain = new Float32Array(memory.buffer, lay.regions.ioScratch.params["gain"]!, 128);
  gain.fill(0.5);

  process();

  const outCh0 = new Float32Array(memory.buffer, lay.regions.ioScratch.outputs["main"]!, 128);
  const outCh1 = new Float32Array(
    memory.buffer,
    lay.regions.ioScratch.outputs["main"]! + 128 * 4,
    128,
  );
  for (let i = 0; i < 128; i++) {
    expect(outCh0[i]).toBe(0.5);
    expect(outCh1[i]).toBe(0.125);
  }
});

test("`emit` allocates multiple 64KB pages when totalBytes exceeds one page", async () => {
  const declarations: CapturedGraph["declarations"] = [];
  for (let n = 0; n < 130; n++) {
    declarations.push({ kind: "audioInput", name: `in${n}`, channels: 1 });
  }
  const graph: CapturedGraph = { declarations, statements: [] };
  const lay = layout(graph);
  const wasm = await emit(graph, lay);
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  // 2 pages = 131072 bytes allocated (130 inputs * 512 = 66560 > 65536)
  expect(memory.buffer.byteLength).toBe(131072);
});

test("`emit` throws on unknown audioInput port (absent from layout)", async () => {
  const graph: CapturedGraph = {
    declarations: [{ kind: "audioOutput", name: "out", channels: 1 }],
    statements: [
      {
        kind: "audioOutWrite",
        portName: "out",
        channel: 0,
        offset: { kind: "literal", type: "i32", value: 0 },
        value: {
          kind: "audioInRead",
          portName: "ghost",
          channel: 0,
          offset: { kind: "literal", type: "i32", value: 0 },
        },
      },
    ],
  };
  await expect(emit(graph, layout(graph))).rejects.toThrow(/unknown audioInput/);
});

test("`emit` throws on unknown audioOutput port", async () => {
  const graph: CapturedGraph = {
    declarations: [],
    statements: [
      {
        kind: "audioOutWrite",
        portName: "ghost",
        channel: 0,
        offset: { kind: "literal", type: "i32", value: 0 },
        value: { kind: "literal", type: "f32", value: 0 },
      },
    ],
  };
  await expect(emit(graph, layout(graph))).rejects.toThrow(/unknown audioOutput/);
});

test("`emit` throws on unknown param", async () => {
  const graph: CapturedGraph = {
    declarations: [{ kind: "audioOutput", name: "out", channels: 1 }],
    statements: [
      {
        kind: "audioOutWrite",
        portName: "out",
        channel: 0,
        offset: { kind: "literal", type: "i32", value: 0 },
        value: {
          kind: "paramAt",
          paramName: "ghost",
          offset: { kind: "literal", type: "i32", value: 0 },
        },
      },
    ],
  };
  await expect(emit(graph, layout(graph))).rejects.toThrow(/unknown param/);
});

test("`emit` throws on unknown buffer (bufferRead)", async () => {
  const graph: CapturedGraph = {
    declarations: [{ kind: "audioOutput", name: "out", channels: 1 }],
    statements: [
      {
        kind: "audioOutWrite",
        portName: "out",
        channel: 0,
        offset: { kind: "literal", type: "i32", value: 0 },
        value: {
          kind: "bufferRead",
          elementType: "f32",
          name: "ghost",
          index: { kind: "literal", type: "i32", value: 0 },
        },
      },
    ],
  };
  await expect(emit(graph, layout(graph))).rejects.toThrow(/unknown buffer/);
});

test("`emit` throws on unknown buffer (bufferReadInterpolated)", async () => {
  const graph: CapturedGraph = {
    declarations: [{ kind: "audioOutput", name: "out", channels: 1 }],
    statements: [
      {
        kind: "audioOutWrite",
        portName: "out",
        channel: 0,
        offset: { kind: "literal", type: "i32", value: 0 },
        value: {
          kind: "bufferReadInterpolated",
          elementType: "f32",
          name: "ghost",
          pos: { kind: "literal", type: "f32", value: 0 },
        },
      },
    ],
  };
  await expect(emit(graph, layout(graph))).rejects.toThrow(/unknown buffer/);
});

test("`emit` throws on unknown buffer (bufferWrite)", async () => {
  const graph: CapturedGraph = {
    declarations: [],
    statements: [
      {
        kind: "bufferWrite",
        elementType: "f32",
        name: "ghost",
        index: { kind: "literal", type: "i32", value: 0 },
        value: { kind: "literal", type: "f32", value: 1 },
      },
    ],
  };
  await expect(emit(graph, layout(graph))).rejects.toThrow(/unknown buffer/);
});

test("`emit` rejects `forSample` in expression position (= structural guard)", async () => {
  const graph: CapturedGraph = {
    declarations: [{ kind: "audioOutput", name: "main", channels: 1 }],
    statements: [
      {
        kind: "audioOutWrite",
        portName: "main",
        channel: 0,
        offset: { kind: "literal", type: "i32", value: 0 },
        value: { kind: "forSample", stride: 1, body: [] } as unknown as AstNode,
      },
    ],
  };
  await expect(emit(graph, layout(graph))).rejects.toThrow(
    /statement node 'forSample' cannot appear in expression position/,
  );
});

test("`emit` rejects `audioOutWrite` in expression position (= structural guard)", async () => {
  const graph: CapturedGraph = {
    declarations: [{ kind: "audioOutput", name: "main", channels: 1 }],
    statements: [
      {
        kind: "audioOutWrite",
        portName: "main",
        channel: 0,
        offset: { kind: "literal", type: "i32", value: 0 },
        value: {
          kind: "audioOutWrite",
          portName: "main",
          channel: 0,
          offset: { kind: "literal", type: "i32", value: 0 },
          value: { kind: "literal", type: "f32", value: 0 },
        } as unknown as AstNode,
      },
    ],
  };
  await expect(emit(graph, layout(graph))).rejects.toThrow(
    /statement node 'audioOutWrite' cannot appear in expression position/,
  );
});

test("`emit` rejects expression-kind nodes in statement position (= structural guard)", async () => {
  const graph: CapturedGraph = {
    declarations: [],
    statements: [{ kind: "literal", type: "f32", value: 1 } as unknown as AstNode],
  };
  await expect(emit(graph, layout(graph))).rejects.toThrow(
    /expression node 'literal' cannot appear in statement position/,
  );
});

// ─────────────────────────────────────────────────────────────────────────
// stateLoad / stateStore — Phase 7 sub-phase 7.1
// (state.<type> plain factory: load/store WASM emit + subnormal flush guard for f32/f64)
// All 5 scalar type round-trips + subnormal guard boundary cases + unknown slot rejection.
// ─────────────────────────────────────────────────────────────────────────

test("`emitExpression(stateStore)` rejects statement node in expression position", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  expect(() =>
    emitExpression(
      {
        kind: "stateStore",
        type: "f32",
        name: "x",
        value: { kind: "literal", type: "f32", value: 0 },
      },
      emptyLayout,
      mod,
      binaryen,
    ),
  ).toThrow(/statement node 'stateStore' cannot appear in expression position/);
  mod.dispose();
});

test("`emitStatement(stateLoad)` rejects expression node in statement position", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  expect(() =>
    emitStatement({ kind: "stateLoad", type: "f32", name: "x" }, emptyLayout, mod, binaryen),
  ).toThrow(/expression node 'stateLoad' cannot appear in statement position/);
  mod.dispose();
});

test("`emit` throws on unknown state slot in stateLoad", async () => {
  const graph: CapturedGraph = {
    declarations: [{ kind: "audioOutput", name: "main", channels: 1 }],
    statements: [
      {
        kind: "audioOutWrite",
        portName: "main",
        channel: 0,
        offset: { kind: "literal", type: "i32", value: 0 },
        value: { kind: "stateLoad", type: "f32", name: "ghost" },
      },
    ],
  };
  await expect(emit(graph, layout(graph))).rejects.toThrow(/unknown state slot: ghost/);
});

test("`emit` throws on unknown state slot in stateStore", async () => {
  const graph: CapturedGraph = {
    declarations: [],
    statements: [
      {
        kind: "stateStore",
        type: "f32",
        name: "ghost",
        value: { kind: "literal", type: "f32", value: 0 },
      },
    ],
  };
  await expect(emit(graph, layout(graph))).rejects.toThrow(/unknown state slot: ghost/);
});

// Fixture builder for state round-trip tests: store a literal, write
// the loaded result across all samples in forSample, then verify
// output[0] equals the expected value after process().
function makeStateRoundtripGraph(
  type: "f32" | "f64" | "i32" | "i64" | "bool",
  storeValue: AstNode,
  initial: number | bigint | boolean,
): CapturedGraph {
  // f64/i64 cannot be routed through audio output (which is f32), so
  // verification uses a state-to-state round-trip (store into src, load
  // into dst). f32/i32/bool are piped through audio output for direct observation.
  if (type === "f64" || type === "i64") {
    return {
      declarations: [
        { kind: "state", name: "src", type, initial },
        { kind: "state", name: "dst", type, initial },
      ],
      statements: [
        { kind: "stateStore", type, name: "src", value: storeValue },
        {
          kind: "stateStore",
          type,
          name: "dst",
          value: { kind: "stateLoad", type, name: "src" },
        },
      ],
    };
  }
  return {
    declarations: [
      { kind: "state", name: "x", type, initial },
      { kind: "audioOutput", name: "main", channels: 1 },
    ],
    statements: [
      { kind: "stateStore", type, name: "x", value: storeValue },
      {
        kind: "forSample",
        stride: 1,
        body: [
          {
            kind: "audioOutWrite",
            portName: "main",
            channel: 0,
            offset: { kind: "loopCounter" },
            value:
              type === "f32"
                ? { kind: "stateLoad", type: "f32", name: "x" }
                : // i32/bool are internally i32, which type-mismatches audio output (f32).
                  // Direct memory I/O observation skips the audio output path.
                  // A separate fixture handles i32/bool verification via direct memory dump.
                  { kind: "literal", type: "f32", value: 0 },
          },
        ],
      },
    ],
  };
}

test("`emit` state.f32 round-trip = stored value is recovered by load", async () => {
  const graph = makeStateRoundtripGraph("f32", { kind: "literal", type: "f32", value: 7.5 }, 0);
  const lay = layout(graph);
  const wasm = await emit(graph, lay);
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  proc();
  const out = new Float32Array(memory.buffer, lay.regions.ioScratch.outputs["main"]!, 128);
  for (let i = 0; i < 128; i++) {
    expect(out[i]).toBe(7.5);
  }
});

test("`emit` state.f32 subnormal flush = 1e-40 stored, loaded as 0", async () => {
  const graph = makeStateRoundtripGraph("f32", { kind: "literal", type: "f32", value: 1e-40 }, 0);
  const lay = layout(graph);
  const wasm = await emit(graph, lay);
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  proc();
  const out = new Float32Array(memory.buffer, lay.regions.ioScratch.outputs["main"]!, 128);
  expect(out[0]).toBe(0);
});

test("`emit` state.f32 subnormal threshold = 1e-29 stored and preserved (above flush boundary)", async () => {
  const graph = makeStateRoundtripGraph("f32", { kind: "literal", type: "f32", value: 1e-29 }, 0);
  const lay = layout(graph);
  const wasm = await emit(graph, lay);
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  proc();
  const out = new Float32Array(memory.buffer, lay.regions.ioScratch.outputs["main"]!, 128);
  // 1e-29 is representable as f32; Math.fround gives the same approximation (outside subnormal range)
  expect(out[0]).toBeCloseTo(Math.fround(1e-29), 35);
  expect(out[0]).not.toBe(0);
});

test("`emit` state.f64 round-trip + subnormal flush via memory dump", async () => {
  // f64 cannot be routed through audio output (f32), so verification uses a state-to-state
  // round-trip with direct memory reads. Store 1e-40 into src -> guard flushes to 0 -> copy to dst -> read dst slot.
  const graph = makeStateRoundtripGraph("f64", { kind: "literal", type: "f64", value: 1e-40 }, 0);
  const lay = layout(graph);
  const wasm = await emit(graph, lay);
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  proc();
  const srcOffset = lay.regions.states.slots["src"]!;
  const dstOffset = lay.regions.states.slots["dst"]!;
  const srcView = new Float64Array(memory.buffer, srcOffset, 1);
  const dstView = new Float64Array(memory.buffer, dstOffset, 1);
  // 1e-40 stored -> subnormal guard flushes to 0
  expect(srcView[0]).toBe(0);
  expect(dstView[0]).toBe(0);
});

test("`emit` state.f64 subnormal threshold = 1e-29 stored and preserved", async () => {
  const graph = makeStateRoundtripGraph("f64", { kind: "literal", type: "f64", value: 1e-29 }, 0);
  const lay = layout(graph);
  const wasm = await emit(graph, lay);
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  proc();
  const srcView = new Float64Array(memory.buffer, lay.regions.states.slots["src"]!, 1);
  expect(srcView[0]).toBeCloseTo(1e-29, 35);
  expect(srcView[0]).not.toBe(0);
});

test("`emit` state.i32 round-trip via memory dump (subnormal guard does not apply)", async () => {
  const graph: CapturedGraph = {
    declarations: [{ kind: "state", name: "x", type: "i32", initial: 0 }],
    statements: [
      {
        kind: "stateStore",
        type: "i32",
        name: "x",
        value: { kind: "literal", type: "i32", value: 42 },
      },
    ],
  };
  const lay = layout(graph);
  const wasm = await emit(graph, lay);
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  proc();
  const view = new Int32Array(memory.buffer, lay.regions.states.slots["x"]!, 1);
  expect(view[0]).toBe(42);
});

test("`emit` state.i64 round-trip via memory dump", async () => {
  // i64 cannot be routed through audio output, so verification uses a state-to-state
  // round-trip with direct memory reads. i64 literals are awkward because AstNode
  // literal.value is typed as number, so this test uses a simple 0 round-trip to
  // exercise the i64 code path (layout allocates an 8-byte slot; emit goes through i64.store).
  const graph: CapturedGraph = {
    declarations: [{ kind: "state", name: "x", type: "i64", initial: 0n }],
    statements: [
      {
        kind: "stateStore",
        type: "i64",
        name: "x",
        // Direct i64 literal representation is constrained by the ast.ts literal (value: number)
        // type, so this uses a stateLoad round-trip to restore the initial value of 0.
        value: { kind: "stateLoad", type: "i64", name: "x" },
      },
    ],
  };
  const lay = layout(graph);
  const wasm = await emit(graph, lay);
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  proc();
  const view = new BigInt64Array(memory.buffer, lay.regions.states.slots["x"]!, 1);
  expect(view[0]).toBe(0n); // initial memory is zero; load -> store preserves it
});

test("`emit` state.bool round-trip via memory dump (internally represented as i32)", async () => {
  const graph: CapturedGraph = {
    declarations: [{ kind: "state", name: "x", type: "bool", initial: false }],
    statements: [
      {
        kind: "stateStore",
        type: "bool",
        name: "x",
        value: { kind: "literal", type: "i32", value: 1 },
      },
    ],
  };
  const lay = layout(graph);
  const wasm = await emit(graph, lay);
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  proc();
  const view = new Int32Array(memory.buffer, lay.regions.states.slots["x"]!, 1);
  expect(view[0]).toBe(1);
});

test("`emit` state.i32 stateLoad hit via state ↔ state copy", async () => {
  const graph: CapturedGraph = {
    declarations: [
      { kind: "state", name: "src", type: "i32", initial: 0 },
      { kind: "state", name: "dst", type: "i32", initial: 0 },
    ],
    statements: [
      {
        kind: "stateStore",
        type: "i32",
        name: "src",
        value: { kind: "literal", type: "i32", value: 99 },
      },
      {
        kind: "stateStore",
        type: "i32",
        name: "dst",
        value: { kind: "stateLoad", type: "i32", name: "src" },
      },
    ],
  };
  const lay = layout(graph);
  const wasm = await emit(graph, lay);
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  proc();
  const view = new Int32Array(memory.buffer, lay.regions.states.slots["dst"]!, 1);
  expect(view[0]).toBe(99);
});

test("`emit` state.bool stateLoad hit via state ↔ state copy", async () => {
  const graph: CapturedGraph = {
    declarations: [
      { kind: "state", name: "src", type: "bool", initial: false },
      { kind: "state", name: "dst", type: "bool", initial: false },
    ],
    statements: [
      {
        kind: "stateStore",
        type: "bool",
        name: "src",
        value: { kind: "literal", type: "i32", value: 1 },
      },
      {
        kind: "stateStore",
        type: "bool",
        name: "dst",
        value: { kind: "stateLoad", type: "bool", name: "src" },
      },
    ],
  };
  const lay = layout(graph);
  const wasm = await emit(graph, lay);
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  proc();
  const view = new Int32Array(memory.buffer, lay.regions.states.slots["dst"]!, 1);
  expect(view[0]).toBe(1);
});

test("`emitExpression(literal bool)` emits i32.const (bool is internally represented as i32 0/1)", async () => {
  // A boolean branch in select (e.g. `select(cond, true, boolNode)`, the canonical bool-state
  // pattern) is lifted to a bool literal and must lower to i32.const in emit.
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  const ref = emitExpression(
    { kind: "literal", type: "bool", value: 1 },
    emptyLayout,
    mod,
    binaryen,
  );
  expect(watOfExpression(mod, binaryen, ref, binaryen.i32)).toContain("(i32.const 1)");
  mod.dispose();
});

// ─────────────────────────────────────────────────────────────────────────
// Subnormal guard behavior specification (spec-state-store-behavior.md)
// Exhaustive coverage: value source variations x inside/outside forSample
// x boundary values x special values — guard applies uniformly in all cases.
// ─────────────────────────────────────────────────────────────────────────

// Per value source: build the store-value AST directly, do a state.f32 round-trip,
// and confirm the result via memory dump.
function makeStoreValueGraph(
  storeValue: AstNode,
  extraDeclarations: CapturedGraph["declarations"] = [],
): CapturedGraph {
  return {
    declarations: [{ kind: "state", name: "z", type: "f32", initial: 0 }, ...extraDeclarations],
    statements: [{ kind: "stateStore", type: "f32", name: "z", value: storeValue }],
  };
}

async function runStoreAndRead(graph: CapturedGraph): Promise<number> {
  const lay = layout(graph);
  const wasm = await emit(graph, lay);
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  proc();
  const view = new Float32Array(memory.buffer, lay.regions.states.slots["z"]!, 1);
  return view[0]!;
}

test("subnormal guard: literal store in normal range is preserved", async () => {
  const stored = await runStoreAndRead(
    makeStoreValueGraph({ kind: "literal", type: "f32", value: 0.5 }),
  );
  expect(stored).toBe(0.5);
});

test("subnormal guard: literal store in subnormal range is flushed to 0", async () => {
  const stored = await runStoreAndRead(
    makeStoreValueGraph({ kind: "literal", type: "f32", value: 1e-40 }),
  );
  expect(stored).toBe(0);
});

test("subnormal guard: exact boundary 1e-30 is preserved (strict `<` flush rule)", async () => {
  const stored = await runStoreAndRead(
    makeStoreValueGraph({ kind: "literal", type: "f32", value: 1e-30 }),
  );
  // 1e-30 rounds to ~1.000000035e-30 in f32; guard condition is abs < 1e-30,
  // so the boundary value itself is not flushed (preserved)
  expect(stored).toBeCloseTo(Math.fround(1e-30), 35);
  expect(stored).not.toBe(0);
});

test("subnormal guard: just below boundary 1e-31 is flushed", async () => {
  const stored = await runStoreAndRead(
    makeStoreValueGraph({ kind: "literal", type: "f32", value: 1e-31 }),
  );
  expect(stored).toBe(0);
});

test("subnormal guard: negative -1e-40 is judged by abs and flushed", async () => {
  const stored = await runStoreAndRead(
    makeStoreValueGraph({ kind: "literal", type: "f32", value: -1e-40 }),
  );
  expect(stored).toBe(0);
});

test("subnormal guard: negative normal -0.5 is preserved", async () => {
  const stored = await runStoreAndRead(
    makeStoreValueGraph({ kind: "literal", type: "f32", value: -0.5 }),
  );
  expect(stored).toBe(-0.5);
});

test("subnormal guard: mul(literal, literal) result in normal range is preserved", async () => {
  // 2 * 0.5 = 1.0
  const stored = await runStoreAndRead(
    makeStoreValueGraph({
      kind: "mul",
      type: "f32",
      lhs: { kind: "literal", type: "f32", value: 2 },
      rhs: { kind: "literal", type: "f32", value: 0.5 },
    }),
  );
  expect(stored).toBe(1);
});

test("subnormal guard: mul(literal, literal) result in subnormal range is flushed", async () => {
  // 1e-20 * 1e-15 = 1e-35 = subnormal range
  const stored = await runStoreAndRead(
    makeStoreValueGraph({
      kind: "mul",
      type: "f32",
      lhs: { kind: "literal", type: "f32", value: 1e-20 },
      rhs: { kind: "literal", type: "f32", value: 1e-15 },
    }),
  );
  expect(stored).toBe(0);
});

test("subnormal guard: stateLoad source — value loaded from another state slot is preserved on store", async () => {
  // Store 0.7 into src, then store src.read() into dst (passes guard, 0.7 preserved)
  const graph: CapturedGraph = {
    declarations: [
      { kind: "state", name: "src", type: "f32", initial: 0 },
      { kind: "state", name: "dst", type: "f32", initial: 0 },
    ],
    statements: [
      {
        kind: "stateStore",
        type: "f32",
        name: "src",
        value: { kind: "literal", type: "f32", value: 0.7 },
      },
      {
        kind: "stateStore",
        type: "f32",
        name: "dst",
        value: { kind: "stateLoad", type: "f32", name: "src" },
      },
    ],
  };
  const lay = layout(graph);
  const wasm = await emit(graph, lay);
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  proc();
  const dstView = new Float32Array(memory.buffer, lay.regions.states.slots["dst"]!, 1);
  expect(dstView[0]).toBe(Math.fround(0.7));
});

test("subnormal guard: self-load * literal chain (counter * 0.5 decay path)", async () => {
  // Store 0.8 into counter, then store counter * 0.5 -> expect 0.4 in memory
  const graph: CapturedGraph = {
    declarations: [{ kind: "state", name: "counter", type: "f32", initial: 0 }],
    statements: [
      {
        kind: "stateStore",
        type: "f32",
        name: "counter",
        value: { kind: "literal", type: "f32", value: 0.8 },
      },
      {
        kind: "stateStore",
        type: "f32",
        name: "counter",
        value: {
          kind: "mul",
          type: "f32",
          lhs: { kind: "stateLoad", type: "f32", name: "counter" },
          rhs: { kind: "literal", type: "f32", value: 0.5 },
        },
      },
    ],
  };
  const lay = layout(graph);
  const wasm = await emit(graph, lay);
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  proc();
  const view = new Float32Array(memory.buffer, lay.regions.states.slots["counter"]!, 1);
  expect(view[0]).toBeCloseTo(0.4, 6);
});

test("subnormal guard: audioInRead * literal, outside forSample (per-block top-level)", async () => {
  // input[0] = 0.3, store value = audioInRead * 2, expect 0.6 (passes guard).
  // Verifies that value sources involving audio I/O memory loads also pass the guard.
  const graph: CapturedGraph = {
    declarations: [
      { kind: "state", name: "z", type: "f32", initial: 0 },
      { kind: "audioInput", name: "main", channels: 1 },
    ],
    statements: [
      {
        kind: "stateStore",
        type: "f32",
        name: "z",
        value: {
          kind: "mul",
          type: "f32",
          lhs: {
            kind: "audioInRead",
            portName: "main",
            channel: 0,
            offset: { kind: "literal", type: "i32", value: 0 },
          },
          rhs: { kind: "literal", type: "f32", value: 2 },
        },
      },
    ],
  };
  const lay = layout(graph);
  const wasm = await emit(graph, lay);
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  const inputView = new Float32Array(memory.buffer, lay.regions.ioScratch.inputs["main"]!, 128);
  inputView.fill(0.3);
  proc();
  const view = new Float32Array(memory.buffer, lay.regions.states.slots["z"]!, 1);
  expect(view[0]).toBeCloseTo(0.6, 6);
});

test("subnormal guard: audioInRead * literal, inside forSample", async () => {
  // Store input[i] * 2 inside forSample, overwriting each sample. The last write (i=127)
  // remains in memory: input[127] * 2 = 0.3 * 2 = 0.6 expected.
  const graph: CapturedGraph = {
    declarations: [
      { kind: "state", name: "z", type: "f32", initial: 0 },
      { kind: "audioInput", name: "main", channels: 1 },
    ],
    statements: [
      {
        kind: "forSample",
        stride: 1,
        body: [
          {
            kind: "stateStore",
            type: "f32",
            name: "z",
            value: {
              kind: "mul",
              type: "f32",
              lhs: {
                kind: "audioInRead",
                portName: "main",
                channel: 0,
                offset: { kind: "loopCounter" },
              },
              rhs: { kind: "literal", type: "f32", value: 2 },
            },
          },
        ],
      },
    ],
  };
  const lay = layout(graph);
  const wasm = await emit(graph, lay);
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  const inputView = new Float32Array(memory.buffer, lay.regions.ioScratch.inputs["main"]!, 128);
  inputView.fill(0.3);
  proc();
  const view = new Float32Array(memory.buffer, lay.regions.states.slots["z"]!, 1);
  expect(view[0]).toBeCloseTo(0.6, 6);
});

test("subnormal guard: paramAt * literal, inside forSample", async () => {
  const graph: CapturedGraph = {
    declarations: [
      { kind: "state", name: "z", type: "f32", initial: 0 },
      {
        kind: "param",
        name: "gain",
        type: "f32",
        default: 0,
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
            kind: "stateStore",
            type: "f32",
            name: "z",
            value: {
              kind: "mul",
              type: "f32",
              lhs: { kind: "paramAt", paramName: "gain", offset: { kind: "loopCounter" } },
              rhs: { kind: "literal", type: "f32", value: 3 },
            },
          },
        ],
      },
    ],
  };
  const lay = layout(graph);
  const wasm = await emit(graph, lay);
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  const paramView = new Float32Array(memory.buffer, lay.regions.ioScratch.params["gain"]!, 128);
  paramView.fill(0.2);
  proc();
  const view = new Float32Array(memory.buffer, lay.regions.states.slots["z"]!, 1);
  expect(view[0]).toBeCloseTo(0.6, 6);
});

test("subnormal guard: deeply nested mul chain (3 levels)", async () => {
  // (((0.4 * 0.5) * 0.5) * 0.5) = 0.05
  const storeValue: AstNode = {
    kind: "mul",
    type: "f32",
    lhs: {
      kind: "mul",
      type: "f32",
      lhs: {
        kind: "mul",
        type: "f32",
        lhs: { kind: "literal", type: "f32", value: 0.4 },
        rhs: { kind: "literal", type: "f32", value: 0.5 },
      },
      rhs: { kind: "literal", type: "f32", value: 0.5 },
    },
    rhs: { kind: "literal", type: "f32", value: 0.5 },
  };
  const stored = await runStoreAndRead(makeStoreValueGraph(storeValue));
  expect(stored).toBeCloseTo(0.05, 6);
});

test("subnormal guard: NaN store bypasses guard and is preserved (NaN < 1e-30 = false in IEEE 754)", async () => {
  const stored = await runStoreAndRead(
    makeStoreValueGraph({ kind: "literal", type: "f32", value: Number.NaN }),
  );
  expect(Number.isNaN(stored)).toBe(true);
});

test("subnormal guard: +Infinity store is preserved", async () => {
  const stored = await runStoreAndRead(
    makeStoreValueGraph({ kind: "literal", type: "f32", value: Number.POSITIVE_INFINITY }),
  );
  expect(stored).toBe(Number.POSITIVE_INFINITY);
});

test("subnormal guard: -Infinity store is preserved", async () => {
  const stored = await runStoreAndRead(
    makeStoreValueGraph({ kind: "literal", type: "f32", value: Number.NEGATIVE_INFINITY }),
  );
  expect(stored).toBe(Number.NEGATIVE_INFINITY);
});

test("subnormal guard: -0 store is flushed to +0 (abs(-0) = 0 < 1e-30)", async () => {
  const stored = await runStoreAndRead(
    makeStoreValueGraph({ kind: "literal", type: "f32", value: -0 }),
  );
  // Store -0 -> guard flushes to 0 -> memory bit pattern is +0.
  // Object.is distinguishes +0/-0; this path asserts +0 after flush.
  expect(Object.is(stored, 0)).toBe(true);
});

test("subnormal guard: two stores to the same state in one block — last write (0.7) wins", async () => {
  const graph: CapturedGraph = {
    declarations: [{ kind: "state", name: "z", type: "f32", initial: 0 }],
    statements: [
      {
        kind: "stateStore",
        type: "f32",
        name: "z",
        value: { kind: "literal", type: "f32", value: 0.3 },
      },
      {
        kind: "stateStore",
        type: "f32",
        name: "z",
        value: { kind: "literal", type: "f32", value: 0.7 },
      },
    ],
  };
  const lay = layout(graph);
  const wasm = await emit(graph, lay);
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  proc();
  const view = new Float32Array(memory.buffer, lay.regions.states.slots["z"]!, 1);
  // 0.7 rounded to f32 = 0.699999988079071; that bit pattern is what gets stored
  expect(view[0]).toBe(Math.fround(0.7));
});

test("subnormal guard: defineProcessor path repro (same graph construction route as offline tests)", async () => {
  // Import side-effect: registers `.mul` method on the Node prototype
  await import("../dsl/primitives.ts");
  const { defineProcessor } = await import("../processor.ts");
  const { audioInput, audioOutput, state } = await import("../dsl/declarations.ts");
  const { forSample } = await import("../dsl/loop.ts");

  const accumulator = defineProcessor(() => {
    const input = audioInput({ channels: 1, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    const stored = state.f32(0);
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(stored.read());
        });
        stored.write(input.ch(0).at(0).mul(2));
      },
    };
  });

  // Extract the captured graph and emit + run it directly
  const capturedGraph = accumulator.graph as unknown as CapturedGraph;
  const lay = layout(capturedGraph);
  const wasm = await emit(capturedGraph, lay);
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;

  const inputBase = lay.regions.ioScratch.inputs["main"]!;
  const outputBase = lay.regions.ioScratch.outputs["main"]!;

  // block 0: input fill 0.3 → proc
  const input0 = new Float32Array(memory.buffer, inputBase, 128);
  for (let s = 0; s < 128; s++) input0[s] = 0.3;
  proc();
  const output0 = new Float32Array(memory.buffer, outputBase, 128);
  for (let s = 0; s < 128; s++) expect(output0[s]).toBe(0);

  // block 1: input fill 0.7 → proc
  const input1 = new Float32Array(memory.buffer, inputBase, 128);
  for (let s = 0; s < 128; s++) input1[s] = 0.7;
  proc();
  const output1 = new Float32Array(memory.buffer, outputBase, 128);
  for (let s = 0; s < 128; s++) expect(output1[s]).toBeCloseTo(0.6, 6);
});

test("subnormal guard: renderOffline-equivalent loop repro (input fill -> proc -> output read, twice)", async () => {
  // Detailed repro of the NaN-producing path in renderOffline:
  // - inside forSample: write out[i] = z.read()
  // - outside forSample: store z = input[0] * 2
  // - input fill 0.3 -> proc -> check output (block 0)
  // - input fill 0.7 -> proc -> check output (block 1) <- NaN trigger
  const graph: CapturedGraph = {
    declarations: [
      { kind: "audioInput", name: "main", channels: 1 },
      { kind: "audioOutput", name: "main", channels: 1 },
      { kind: "state", name: "z", type: "f32", initial: 0 },
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
            value: { kind: "stateLoad", type: "f32", name: "z" },
          },
        ],
      },
      {
        kind: "stateStore",
        type: "f32",
        name: "z",
        value: {
          kind: "mul",
          type: "f32",
          lhs: {
            kind: "audioInRead",
            portName: "main",
            channel: 0,
            offset: { kind: "literal", type: "i32", value: 0 },
          },
          rhs: { kind: "literal", type: "f32", value: 2 },
        },
      },
    ],
  };
  const lay = layout(graph);
  const wasm = await emit(graph, lay);
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  const inputBase = lay.regions.ioScratch.inputs["main"]!;
  const outputBase = lay.regions.ioScratch.outputs["main"]!;

  // block 0: input fill 0.3 -> proc -> check output
  const input0 = new Float32Array(memory.buffer, inputBase, 128);
  for (let s = 0; s < 128; s++) input0[s] = 0.3;
  proc();
  const output0 = new Float32Array(memory.buffer, outputBase, 128);
  // block 0: z initial value = 0 -> entire output is 0
  for (let s = 0; s < 128; s++) expect(output0[s]).toBe(0);

  // block 1: input fill 0.7 -> proc -> check output
  const input1 = new Float32Array(memory.buffer, inputBase, 128);
  for (let s = 0; s < 128; s++) input1[s] = 0.7;
  proc();
  const output1 = new Float32Array(memory.buffer, outputBase, 128);
  // block 1: z = 0.6 stored at the end of block 0 -> entire output is 0.6
  for (let s = 0; s < 128; s++) expect(output1[s]).toBeCloseTo(0.6, 6);
});

test("subnormal guard: audioInRead * literal store after forSample, process called twice (multi-block drive path)", async () => {
  // Calling proc() twice exercises the multi-block drive path: the state slot persists across render quanta.
  const graph: CapturedGraph = {
    declarations: [
      { kind: "audioInput", name: "main", channels: 1 },
      { kind: "audioOutput", name: "main", channels: 1 },
      { kind: "state", name: "z", type: "f32", initial: 0 },
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
            value: { kind: "stateLoad", type: "f32", name: "z" },
          },
        ],
      },
      {
        kind: "stateStore",
        type: "f32",
        name: "z",
        value: {
          kind: "mul",
          type: "f32",
          lhs: {
            kind: "audioInRead",
            portName: "main",
            channel: 0,
            offset: { kind: "literal", type: "i32", value: 0 },
          },
          rhs: { kind: "literal", type: "f32", value: 2 },
        },
      },
    ],
  };
  const lay = layout(graph);
  const wasm = await emit(graph, lay);
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  const inputView = new Float32Array(memory.buffer, lay.regions.ioScratch.inputs["main"]!, 128);
  inputView.fill(0.3);
  proc();
  // 1st call: z = 0.6 expected
  const view1 = new Float32Array(memory.buffer, lay.regions.states.slots["z"]!, 1);
  expect(view1[0]).toBeCloseTo(0.6, 6);
  // 2nd call: input still 0.3, z = 0.6 expected (no NaN)
  proc();
  const view2 = new Float32Array(memory.buffer, lay.regions.states.slots["z"]!, 1);
  expect(view2[0]).toBeCloseTo(0.6, 6);
});

test("subnormal guard: audioInRead * literal store after forSample (offline integration repro)", async () => {
  // Reproduces the NaN-producing fixture from offline/index.test.ts at the emit unit level:
  // forSample writes stateLoad to audioOutput; outside forSample, stateStore stores audioInRead * 2.
  // input = 0.3 -> z = 0.6 expected.
  const graph: CapturedGraph = {
    declarations: [
      { kind: "audioInput", name: "main", channels: 1 },
      { kind: "audioOutput", name: "main", channels: 1 },
      { kind: "state", name: "z", type: "f32", initial: 0 },
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
            value: { kind: "stateLoad", type: "f32", name: "z" },
          },
        ],
      },
      {
        kind: "stateStore",
        type: "f32",
        name: "z",
        value: {
          kind: "mul",
          type: "f32",
          lhs: {
            kind: "audioInRead",
            portName: "main",
            channel: 0,
            offset: { kind: "literal", type: "i32", value: 0 },
          },
          rhs: { kind: "literal", type: "f32", value: 2 },
        },
      },
    ],
  };
  const lay = layout(graph);
  const wasm = await emit(graph, lay);
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  const inputView = new Float32Array(memory.buffer, lay.regions.ioScratch.inputs["main"]!, 128);
  inputView.fill(0.3);
  proc();
  const view = new Float32Array(memory.buffer, lay.regions.states.slots["z"]!, 1);
  expect(view[0]).toBeCloseTo(0.6, 6);
});

// ─────────────────────────────────────────────────────────────────────────
// Per-block publish scheduler — Phase 7 sub-phase 7.3
// (state slots with publish flag: at process end, counter += 128;
//  when counter >= threshold: copy + increment version + counter -= threshold)
// ─────────────────────────────────────────────────────────────────────────

test("publish scheduler: processor with no publish slots is unaffected (regression)", async () => {
  const graph: CapturedGraph = {
    declarations: [{ kind: "state", name: "z", type: "f32", initial: 0 }],
    statements: [
      {
        kind: "stateStore",
        type: "f32",
        name: "z",
        value: { kind: "literal", type: "f32", value: 0.5 },
      },
    ],
  };
  const lay = layout(graph);
  const wasm = await emit(graph, lay);
  // publishShared/Counters regions are empty; total bytes end at the state region
  expect(wasm).toBeInstanceOf(Uint8Array);
  // basic regression: emit succeeds and 0.5 is stored in the state slot
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  proc();
  const view = new Float32Array(memory.buffer, lay.regions.states.slots["z"]!, 1);
  expect(view[0]).toBe(0.5);
});

test("publish scheduler: f32 single slot — counter += 128, triggers when threshold exceeded", async () => {
  // sampleRate 48000, rateFps 30 -> threshold = round(1600) = 1600
  // blocks 0..12 = not due (counter = 128..1664)
  // block 13: 1664 >= 1600 = due -> copy + version 1 + counter = 64
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "state",
        name: "meterL",
        type: "f32",
        initial: 0,
        userNamed: true,
        publish: { rateFps: 30 },
      },
    ],
    statements: [
      {
        kind: "stateStore",
        type: "f32",
        name: "meterL",
        value: { kind: "literal", type: "f32", value: 0.7 },
      },
    ],
  };
  const lay = layout(graph);
  const wasm = await emit(graph, lay, { sampleRate: 48000 });
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  const stateView = new Float32Array(memory.buffer, lay.regions.states.slots["meterL"]!, 1);
  const sharedView = new Float32Array(memory.buffer, lay.regions.publishShared.slots["meterL"]!, 1);
  const counterView = new Int32Array(
    memory.buffer,
    lay.regions.publishCounters.slots["meterL"]!,
    2,
  );

  // block 0..12 = not due
  for (let b = 0; b < 13; b++) {
    proc();
  }
  // sample counter = 13 * 128 = 1664, but after block 13 fires due = 64
  expect(counterView[0]).toBe(64);
  expect(counterView[1]).toBe(1); // version = 1
  expect(sharedView[0]).toBe(Math.fround(0.7)); // copied
  // state side is also 0.7 (from store)
  expect(stateView[0]).toBe(Math.fround(0.7));
});

test("publish scheduler: fires twice across consecutive blocks (version increments)", async () => {
  // sampleRate 48000, rateFps 30 -> threshold 1600
  // block 13: first due (counter 64); block 25: second due
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "state",
        name: "x",
        type: "i32",
        initial: 0,
        userNamed: true,
        publish: { rateFps: 30 },
      },
    ],
    statements: [
      {
        kind: "stateStore",
        type: "i32",
        name: "x",
        value: { kind: "literal", type: "i32", value: 42 },
      },
    ],
  };
  const lay = layout(graph);
  const wasm = await emit(graph, lay, { sampleRate: 48000 });
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  const counterView = new Int32Array(memory.buffer, lay.regions.publishCounters.slots["x"]!, 2);

  // Run 25 blocks (1664 + 12 * 128 = 3200 = 2 * 1600)
  for (let b = 0; b < 25; b++) {
    proc();
  }
  // block 13 = due 1 (counter 64)
  // blocks 14..24: counter 64 + 11 * 128 = 1472
  // block 25: counter 1472 + 128 = 1600 >= 1600 = due 2 -> counter 0
  expect(counterView[0]).toBe(0);
  expect(counterView[1]).toBe(2); // version = 2
});

test("publish scheduler: i32 type value is copied on due", async () => {
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "state",
        name: "x",
        type: "i32",
        initial: 0,
        userNamed: true,
        publish: { rateFps: 100 },
      },
    ],
    statements: [
      {
        kind: "stateStore",
        type: "i32",
        name: "x",
        value: { kind: "literal", type: "i32", value: 99 },
      },
    ],
  };
  const lay = layout(graph);
  // sampleRate 48000 / rateFps 100 = threshold 480
  const wasm = await emit(graph, lay, { sampleRate: 48000 });
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  const sharedView = new Int32Array(memory.buffer, lay.regions.publishShared.slots["x"]!, 1);

  // Run 4 blocks: counter 512 >= 480 = due
  for (let b = 0; b < 4; b++) {
    proc();
  }
  expect(sharedView[0]).toBe(99);
});

test("publish scheduler: bool type value is copied on due (internally i32)", async () => {
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "state",
        name: "gate",
        type: "bool",
        initial: false,
        userNamed: true,
        publish: { rateFps: 100 },
      },
    ],
    statements: [
      {
        kind: "stateStore",
        type: "bool",
        name: "gate",
        value: { kind: "literal", type: "i32", value: 1 },
      },
    ],
  };
  const lay = layout(graph);
  const wasm = await emit(graph, lay, { sampleRate: 48000 });
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  const sharedView = new Int32Array(memory.buffer, lay.regions.publishShared.slots["gate"]!, 1);

  // 4 blocks: counter 512 >= 480 = due
  for (let b = 0; b < 4; b++) {
    proc();
  }
  expect(sharedView[0]).toBe(1);
});

test("publish scheduler: two publish slots have independent counters and versions", async () => {
  // slot 1: rateFps 30 (threshold 1600); slot 2: rateFps 60 (threshold 800)
  // After 13 blocks:
  // - slot1: 1664 -> due 1, counter 64, version 1
  // - slot2: due twice (800/128=6.25; block 7: 896>=800 -> due 1, counter 96;
  //   block 13: counter 96+6*128=864>=800 -> due 2, counter 64)
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "state",
        name: "slow",
        type: "f32",
        initial: 0,
        userNamed: true,
        publish: { rateFps: 30 },
      },
      {
        kind: "state",
        name: "fast",
        type: "f32",
        initial: 0,
        userNamed: true,
        publish: { rateFps: 60 },
      },
    ],
    statements: [],
  };
  const lay = layout(graph);
  const wasm = await emit(graph, lay, { sampleRate: 48000 });
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  const slowCounter = new Int32Array(memory.buffer, lay.regions.publishCounters.slots["slow"]!, 2);
  const fastCounter = new Int32Array(memory.buffer, lay.regions.publishCounters.slots["fast"]!, 2);

  for (let b = 0; b < 13; b++) {
    proc();
  }
  // slow (rateFps 30, threshold 1600): version 1, counter 64
  expect(slowCounter[1]).toBe(1);
  expect(slowCounter[0]).toBe(64);
  // fast (rateFps 60, threshold 800): due 1 at block 7, due 2 at block 13 (counter 96+6*128=864 -> 64)
  expect(fastCounter[1]).toBe(2);
  expect(fastCounter[0]).toBe(64);
});

test("publish scheduler: threshold rounds to 0 — fires every block", async () => {
  // sampleRate 100, rateFps 1000 -> threshold = round(0.1) = 0
  // After counter += 128: 128 >= 0 = due every block; counter -= 0 leaves 128, so next block fires too
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "state",
        name: "x",
        type: "f32",
        initial: 0,
        userNamed: true,
        publish: { rateFps: 1000 },
      },
    ],
    statements: [],
  };
  const lay = layout(graph);
  const wasm = await emit(graph, lay, { sampleRate: 100 });
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  const counterView = new Int32Array(memory.buffer, lay.regions.publishCounters.slots["x"]!, 2);

  // Run 5 blocks — fires every block
  for (let b = 0; b < 5; b++) {
    proc();
  }
  // Each block: 128 >= 0 = due -> counter -= 0 = 128 -> next block also fires; 5 dues total, counter 128
  // version = 5
  expect(counterView[1]).toBe(5);
});

test("publish scheduler: sampleRate option is reflected (threshold scales with sampleRate)", async () => {
  // Same processor: sampleRate 48000 vs 96000 = threshold 1600 vs 3200
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "state",
        name: "x",
        type: "f32",
        initial: 0,
        userNamed: true,
        publish: { rateFps: 30 },
      },
    ],
    statements: [],
  };
  const lay = layout(graph);

  // sampleRate 48000 -> threshold 1600 -> due at block 13
  const wasm48 = await emit(graph, lay, { sampleRate: 48000 });
  const mod48 = await WebAssembly.compile(wasm48.buffer as ArrayBuffer);
  const inst48 = await WebAssembly.instantiate(mod48);
  const proc48 = inst48.exports["process"] as () => void;
  const counter48 = new Int32Array(
    (inst48.exports["memory"] as WebAssembly.Memory).buffer,
    lay.regions.publishCounters.slots["x"]!,
    2,
  );
  for (let b = 0; b < 13; b++) proc48();
  expect(counter48[1]).toBe(1); // version = 1

  // sampleRate 96000 -> threshold 3200 -> due at block 25
  const wasm96 = await emit(graph, lay, { sampleRate: 96000 });
  const mod96 = await WebAssembly.compile(wasm96.buffer as ArrayBuffer);
  const inst96 = await WebAssembly.instantiate(mod96);
  const proc96 = inst96.exports["process"] as () => void;
  const counter96 = new Int32Array(
    (inst96.exports["memory"] as WebAssembly.Memory).buffer,
    lay.regions.publishCounters.slots["x"]!,
    2,
  );
  // 13 blocks: no due (counter 1664 < 3200)
  for (let b = 0; b < 13; b++) proc96();
  expect(counter96[1]).toBe(0);
  // 25 blocks: fires
  for (let b = 0; b < 12; b++) proc96();
  expect(counter96[1]).toBe(1);
});

test("subnormal guard f64: stateLoad source (no cross-precision path)", async () => {
  // f64 state-to-state copy via stateLoad (does not go through a literal f64);
  // verifies a different code path from the known NaN bug.
  const graph: CapturedGraph = {
    declarations: [
      { kind: "state", name: "src", type: "f64", initial: 0 },
      { kind: "state", name: "dst", type: "f64", initial: 0 },
    ],
    statements: [
      {
        kind: "stateStore",
        type: "f64",
        name: "src",
        value: { kind: "literal", type: "f64", value: 0.7 },
      },
      {
        kind: "stateStore",
        type: "f64",
        name: "dst",
        value: { kind: "stateLoad", type: "f64", name: "src" },
      },
    ],
  };
  const lay = layout(graph);
  const wasm = await emit(graph, lay);
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  proc();
  const dstView = new Float64Array(memory.buffer, lay.regions.states.slots["dst"]!, 1);
  expect(dstView[0]).toBe(0.7);
});

// ─────────────────────────────────────────────────────────────────────────
// `event.emitIf` WASM emit (sub-phase 7.6 commit 4)
//
// Lowers AST `eventEmitIf` to WASM IR:
// - cond branch (fire when truthy, skip when falsy)
// - overflow check (head+1-tail >= capacity: drop-oldest + overflowCount += 1)
// - slot fill (store atSample + fields at base+12+(head%capacity)*slotSize)
// - head += 1
// SAB Atomics are reflected in the worklet template (commit 5);
// inside WASM, plain i32.load/store is used.
// ─────────────────────────────────────────────────────────────────────────

test("`emit(event emit 128 times)` = all samples fire inside forSample, filling slots 0..127", async () => {
  // Fire emitIf(true, { atSample: i, level: 0.5 }) 128 times inside forSample —
  // fills ringbuffer slots 0..127 with atSample=i, level=0.5; head=128.
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
            cond: { kind: "literal", type: "i32", value: 1 },
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
  const { memory, process } = await instantiate(graph);
  const lay = layout(graph);
  process();
  const ringBase = lay.regions.eventRings.slots["peak"]!.base;
  const headView = new Int32Array(memory.buffer, ringBase, 3);
  expect(headView[0]).toBe(128); // head
  expect(headView[1]).toBe(0); // tail
  expect(headView[2]).toBe(0); // overflowCount
  // slots 0..127: atSample + level = 8 bytes * 128 = 1024 bytes
  const slotsBase = ringBase + 12;
  const slotsAsI32 = new Int32Array(memory.buffer, slotsBase, 128 * 2);
  const slotsAsF32 = new Float32Array(memory.buffer, slotsBase, 128 * 2);
  for (let i = 0; i < 128; i++) {
    expect(slotsAsI32[i * 2]).toBe(i); // atSample
    expect(slotsAsF32[i * 2 + 1]).toBe(0.5); // level
  }
});

test("`emit(event emit cond=false)` = all samples skipped, slots unchanged, head = 0", async () => {
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
            cond: { kind: "literal", type: "i32", value: 0 }, // false
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
  const { memory, process } = await instantiate(graph);
  const lay = layout(graph);
  process();
  const ringBase = lay.regions.eventRings.slots["peak"]!.base;
  const headView = new Int32Array(memory.buffer, ringBase, 3);
  expect(headView[0]).toBe(0); // head unchanged
  expect(headView[1]).toBe(0);
  expect(headView[2]).toBe(0);
});

test("`emit(event overflow)` = 5 emits into capacity-4 ring = head 5 / tail 1 / overflowCount 1", async () => {
  // Fire 5 times into a capacity-4 ring: 4 slots fill, then the 5th triggers drop-oldest once.
  // Expressed as 5 top-level per-block statements (no forSample) to control the fire count.
  const makeEmit = (atSample: number, level: number): AstNode => ({
    kind: "eventEmitIf",
    name: "peak",
    cond: { kind: "literal", type: "i32", value: 1 },
    atSample: { kind: "literal", type: "i32", value: atSample },
    fields: [
      { name: "level", wireType: "f32", value: { kind: "literal", type: "f32", value: level } },
    ],
  });
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "event",
        name: "peak",
        capacity: 4,
        payloadCapacity: undefined,
        fields: [{ name: "level", wireType: "f32" }],
      },
    ],
    statements: [
      makeEmit(0, 0.1),
      makeEmit(1, 0.2),
      makeEmit(2, 0.3),
      makeEmit(3, 0.4),
      makeEmit(4, 0.5),
    ],
  };
  const { memory, process } = await instantiate(graph);
  const lay = layout(graph);
  process();
  const ringBase = lay.regions.eventRings.slots["peak"]!.base;
  const headView = new Int32Array(memory.buffer, ringBase, 3);
  expect(headView[0]).toBe(5); // head
  expect(headView[1]).toBe(1); // tail (advanced once by drop-oldest)
  expect(headView[2]).toBe(1); // overflowCount
  // slot 0 overwritten by 5th emit (atSample=4, level=0.5)
  const slot0AsI32 = new Int32Array(memory.buffer, ringBase + 12, 2);
  const slot0AsF32 = new Float32Array(memory.buffer, ringBase + 12, 2);
  expect(slot0AsI32[0]).toBe(4);
  expect(slot0AsF32[1]).toBe(0.5);
});

test("`emit(event multiple field types)` = atSample (i32) + level (f32) + tick (i32) + flag (bool)", async () => {
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "event",
        name: "evt",
        capacity: 256,
        payloadCapacity: undefined,
        fields: [
          { name: "level", wireType: "f32" },
          { name: "tick", wireType: "i32" },
          { name: "flag", wireType: "bool" },
        ],
      },
    ],
    statements: [
      {
        kind: "eventEmitIf",
        name: "evt",
        cond: { kind: "literal", type: "i32", value: 1 },
        atSample: { kind: "literal", type: "i32", value: 7 },
        fields: [
          {
            name: "level",
            wireType: "f32",
            value: { kind: "literal", type: "f32", value: 0.75 },
          },
          { name: "tick", wireType: "i32", value: { kind: "literal", type: "i32", value: 42 } },
          { name: "flag", wireType: "bool", value: { kind: "literal", type: "i32", value: 1 } },
        ],
      },
    ],
  };
  const { memory, process } = await instantiate(graph);
  const lay = layout(graph);
  process();
  const ringBase =
    lay.regions.eventRings.slots["peak"]?.base ?? lay.regions.eventRings.slots["evt"]!.base;
  const slot0 = new Int32Array(memory.buffer, ringBase + 12, 4);
  const slot0Floats = new Float32Array(memory.buffer, ringBase + 12, 4);
  expect(slot0[0]).toBe(7); // atSample
  expect(slot0Floats[1]).toBe(0.75); // level
  expect(slot0[2]).toBe(42); // tick
  expect(slot0[3]).toBe(1); // flag (occupies a u32 word)
});

test("`emit(event multiple declarations)` = independent fire per base address", async () => {
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "event",
        name: "evt1",
        capacity: 16,
        payloadCapacity: undefined,
        fields: [{ name: "level", wireType: "f32" }],
      },
      {
        kind: "event",
        name: "evt2",
        capacity: 16,
        payloadCapacity: undefined,
        fields: [],
      },
    ],
    statements: [
      {
        kind: "eventEmitIf",
        name: "evt1",
        cond: { kind: "literal", type: "i32", value: 1 },
        atSample: { kind: "literal", type: "i32", value: 0 },
        fields: [
          {
            name: "level",
            wireType: "f32",
            value: { kind: "literal", type: "f32", value: 0.9 },
          },
        ],
      },
      {
        kind: "eventEmitIf",
        name: "evt2",
        cond: { kind: "literal", type: "i32", value: 1 },
        atSample: { kind: "literal", type: "i32", value: 0 },
        fields: [],
      },
    ],
  };
  const { memory, process } = await instantiate(graph);
  const lay = layout(graph);
  process();
  const evt1Base = lay.regions.eventRings.slots["evt1"]!.base;
  const evt2Base = lay.regions.eventRings.slots["evt2"]!.base;
  expect(new Int32Array(memory.buffer, evt1Base, 1)[0]).toBe(1); // evt1 head
  expect(new Int32Array(memory.buffer, evt2Base, 1)[0]).toBe(1); // evt2 head
});

test("`emit(event f64 field)` = atSample (i32) + value (f64) stored as 8 bytes", async () => {
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "event",
        name: "wide",
        capacity: 256,
        payloadCapacity: undefined,
        fields: [{ name: "value", wireType: "f64" }],
      },
    ],
    statements: [
      {
        kind: "eventEmitIf",
        name: "wide",
        cond: { kind: "literal", type: "i32", value: 1 },
        atSample: { kind: "literal", type: "i32", value: 3 },
        fields: [
          {
            name: "value",
            wireType: "f64",
            value: { kind: "literal", type: "f64", value: 1.5 },
          },
        ],
      },
    ],
  };
  const { memory, process } = await instantiate(graph);
  const lay = layout(graph);
  process();
  const ringBase = lay.regions.eventRings.slots["wide"]!.base;
  // slot offset = ringBase + 12 (header) + 0 (atSample) / +4 (value f64)
  // f64 wire fields are written with 4-byte alignment (no WASM mem.store alignment constraint);
  // JS Float64Array requires 8-byte alignment, so read via DataView.
  const view = new DataView(memory.buffer);
  expect(view.getInt32(ringBase + 12, true)).toBe(3); // atSample
  expect(view.getFloat64(ringBase + 12 + 4, true)).toBe(1.5); // value
});

test("`emit(event i64 field)` = atSample (i32) + stamp (i64) stored as 8 bytes", async () => {
  // i64 literal emit is unsupported (ast.ts literal value: number constraint),
  // so the field value is obtained via stateLoad i64.
  const graph: CapturedGraph = {
    declarations: [
      { kind: "state", name: "tick", type: "i64", initial: 0n, userNamed: true },
      {
        kind: "event",
        name: "tickEvt",
        capacity: 256,
        payloadCapacity: undefined,
        fields: [{ name: "stamp", wireType: "i64" }],
      },
    ],
    statements: [
      {
        kind: "eventEmitIf",
        name: "tickEvt",
        cond: { kind: "literal", type: "i32", value: 1 },
        atSample: { kind: "literal", type: "i32", value: 5 },
        fields: [
          {
            name: "stamp",
            wireType: "i64",
            value: { kind: "stateLoad", type: "i64", name: "tick" },
          },
        ],
      },
    ],
  };
  const { memory, process } = await instantiate(graph);
  const lay = layout(graph);
  // Write 42n directly into the tick state slot so stateLoad picks it up
  const tickOffset = lay.regions.states.slots["tick"]!;
  new BigInt64Array(memory.buffer, tickOffset, 1)[0] = 42n;
  process();
  const ringBase = lay.regions.eventRings.slots["tickEvt"]!.base;
  // slot offset = ringBase + 12 (header) + 0 (atSample i32) / +4 (stamp i64)
  // i64 wire fields are written with 4-byte alignment;
  // JS BigInt64Array requires 8-byte alignment, so read via DataView.
  const view = new DataView(memory.buffer);
  expect(view.getInt32(ringBase + 12, true)).toBe(5); // atSample
  expect(view.getBigInt64(ringBase + 12 + 4, true)).toBe(42n); // stamp
});

test("`emit` throws on unknown event slot in eventEmitIf", async () => {
  const graph: CapturedGraph = {
    declarations: [],
    statements: [
      {
        kind: "eventEmitIf",
        name: "ghost",
        cond: { kind: "literal", type: "i32", value: 1 },
        atSample: { kind: "literal", type: "i32", value: 0 },
        fields: [],
      },
    ],
  };
  await expect(emit(graph, layout(graph))).rejects.toThrow(/unknown event slot.*ghost/);
});

// ─────────────────────────────────────────────────────────────────────────
// `message.onReceive` WASM emit (sub-phase 7.7c)
//
// At the start of each quantum: drain all message rings (walk from tail to
// head, run handler body for each slot). `messageFieldRead` inside the handler
// loads from slot offset + field offset. After draining, tail advances to head.
// Q38-b: all handlers run before per-block statements and forSample.
// ─────────────────────────────────────────────────────────────────────────

test("`emit(message onReceive)` = drains ring slots and runs handler body", async () => {
  // Place 1 slot in the ring (simulating main-thread -> worklet send), then
  // call process(). The onReceive handler reflects the field value into a state slot.
  const graph: CapturedGraph = {
    declarations: [
      { kind: "state", name: "captured", type: "i32", initial: 0, userNamed: true },
      {
        kind: "message",
        name: "ctrl",
        capacity: 16,
        payloadCapacity: undefined,
        fields: [{ name: "slot", wireType: "i32" }],
      },
    ],
    statements: [
      {
        kind: "messageOnReceive",
        name: "ctrl",
        body: [
          {
            kind: "stateStore",
            type: "i32",
            name: "captured",
            value: {
              kind: "messageFieldRead",
              name: "ctrl",
              field: "slot",
              wireType: "i32",
            },
          },
        ],
      },
    ],
  };
  const lay = layout(graph);
  const { memory, process } = await instantiate(graph);
  // Main-side simulation: push 1 slot into the ring (slot[0].slot=42, head=1)
  const ringBase = lay.regions.messageRings.slots["ctrl"]!.base;
  const headerView = new Int32Array(memory.buffer, ringBase, 3);
  const slotsView = new Int32Array(memory.buffer, ringBase + 12);
  slotsView[0] = 42;
  headerView[0] = 1; // head = 1
  process();
  // handler fires on drain: 42 is reflected in the captured state slot
  const capturedOffset = lay.regions.states.slots["captured"]!;
  const capturedView = new Int32Array(memory.buffer, capturedOffset, 1);
  expect(capturedView[0]).toBe(42);
  // tail is also advanced to head (fully drained)
  expect(headerView[1]).toBe(1);
});

test("`emit(message onReceive)` = multiple slots fully drained, handler fires for each", async () => {
  const graph: CapturedGraph = {
    declarations: [
      { kind: "state", name: "captured", type: "i32", initial: 0, userNamed: true },
      {
        kind: "message",
        name: "ctrl",
        capacity: 16,
        payloadCapacity: undefined,
        fields: [{ name: "slot", wireType: "i32" }],
      },
    ],
    statements: [
      {
        kind: "messageOnReceive",
        name: "ctrl",
        body: [
          {
            kind: "stateStore",
            type: "i32",
            name: "captured",
            value: {
              kind: "messageFieldRead",
              name: "ctrl",
              field: "slot",
              wireType: "i32",
            },
          },
        ],
      },
    ],
  };
  const lay = layout(graph);
  const { memory, process } = await instantiate(graph);
  const ringBase = lay.regions.messageRings.slots["ctrl"]!.base;
  const headerView = new Int32Array(memory.buffer, ringBase, 3);
  const slotsView = new Int32Array(memory.buffer, ringBase + 12);
  slotsView[0] = 10;
  slotsView[1] = 20;
  slotsView[2] = 30;
  headerView[0] = 3;
  process();
  // Last emit (slot[2]=30) is the final state value (last consecutive fire wins)
  const capturedView = new Int32Array(memory.buffer, lay.regions.states.slots["captured"]!, 1);
  expect(capturedView[0]).toBe(30);
  expect(headerView[1]).toBe(3); // tail = 3 = head
});

test("`emit(message onReceive)` = empty ring (head == tail) — handler not called, skipped", async () => {
  const graph: CapturedGraph = {
    declarations: [
      { kind: "state", name: "captured", type: "i32", initial: 99, userNamed: true },
      {
        kind: "message",
        name: "ctrl",
        capacity: 16,
        payloadCapacity: undefined,
        fields: [{ name: "slot", wireType: "i32" }],
      },
    ],
    statements: [
      {
        kind: "messageOnReceive",
        name: "ctrl",
        body: [
          {
            kind: "stateStore",
            type: "i32",
            name: "captured",
            value: {
              kind: "messageFieldRead",
              name: "ctrl",
              field: "slot",
              wireType: "i32",
            },
          },
        ],
      },
    ],
  };
  const lay = layout(graph);
  const { memory, process } = await instantiate(graph);
  process();
  // Ring empty: handler not fired; state remains at declared initial value (99).
  // (State init is seeded via active data segment at instantiation time.)
  const capturedView = new Int32Array(memory.buffer, lay.regions.states.slots["captured"]!, 1);
  expect(capturedView[0]).toBe(99);
});

test("`emit(message onReceive)` = multiple onReceive registrations — all fire in registration order", async () => {
  const graph: CapturedGraph = {
    declarations: [
      { kind: "state", name: "a", type: "i32", initial: 0, userNamed: true },
      { kind: "state", name: "b", type: "i32", initial: 0, userNamed: true },
      {
        kind: "message",
        name: "ctrl",
        capacity: 16,
        payloadCapacity: undefined,
        fields: [{ name: "slot", wireType: "i32" }],
      },
    ],
    statements: [
      {
        kind: "messageOnReceive",
        name: "ctrl",
        body: [
          {
            kind: "stateStore",
            type: "i32",
            name: "a",
            value: { kind: "messageFieldRead", name: "ctrl", field: "slot", wireType: "i32" },
          },
        ],
      },
      {
        kind: "messageOnReceive",
        name: "ctrl",
        body: [
          {
            kind: "stateStore",
            type: "i32",
            name: "b",
            value: { kind: "messageFieldRead", name: "ctrl", field: "slot", wireType: "i32" },
          },
        ],
      },
    ],
  };
  const lay = layout(graph);
  const { memory, process } = await instantiate(graph);
  const ringBase = lay.regions.messageRings.slots["ctrl"]!.base;
  const headerView = new Int32Array(memory.buffer, ringBase, 3);
  const slotsView = new Int32Array(memory.buffer, ringBase + 12);
  slotsView[0] = 77;
  headerView[0] = 1;
  process();
  const aView = new Int32Array(memory.buffer, lay.regions.states.slots["a"]!, 1);
  const bView = new Int32Array(memory.buffer, lay.regions.states.slots["b"]!, 1);
  expect(aView[0]).toBe(77);
  expect(bView[0]).toBe(77);
});

test("`emit(message onReceive)` = bool wireType field loaded via i32.load (received as 1/0)", async () => {
  const graph: CapturedGraph = {
    declarations: [
      { kind: "state", name: "active", type: "bool", initial: false, userNamed: true },
      {
        kind: "message",
        name: "toggle",
        capacity: 8,
        payloadCapacity: undefined,
        fields: [{ name: "on", wireType: "bool" }],
      },
    ],
    statements: [
      {
        kind: "messageOnReceive",
        name: "toggle",
        body: [
          {
            kind: "stateStore",
            type: "bool",
            name: "active",
            value: { kind: "messageFieldRead", name: "toggle", field: "on", wireType: "bool" },
          },
        ],
      },
    ],
  };
  const lay = layout(graph);
  const { memory, process } = await instantiate(graph);
  const ringBase = lay.regions.messageRings.slots["toggle"]!.base;
  const headerView = new Int32Array(memory.buffer, ringBase, 3);
  const slotsView = new Int32Array(memory.buffer, ringBase + 12);
  slotsView[0] = 1; // on = true (= u32 word 1)
  headerView[0] = 1;
  process();
  const activeView = new Int32Array(memory.buffer, lay.regions.states.slots["active"]!, 1);
  expect(activeView[0]).toBe(1);
});

test("`emit(message onReceive)` = void payload (no fields) — fire count observed via head-tail diff, tail advances on drain", async () => {
  // void payload: slot size 0, exercises the slotSize === 0 code path in slot pointer calculation.
  // Handler body: stateStore with a fixed value to observe fires (overwrites on each call).
  const graph: CapturedGraph = {
    declarations: [
      { kind: "state", name: "fireCount", type: "i32", initial: 0, userNamed: true },
      {
        kind: "message",
        name: "ping",
        capacity: 8,
        payloadCapacity: undefined,
        fields: [],
      },
    ],
    statements: [
      {
        kind: "messageOnReceive",
        name: "ping",
        body: [
          // fireCount += 1 via stateLoad + add is not yet needed here;
          // stateStore with fixed value 1 means only one fire is observable (overwrites).
          // The normative check is tail advancement.
          {
            kind: "stateStore",
            type: "i32",
            name: "fireCount",
            value: { kind: "literal", type: "i32", value: 1 },
          },
        ],
      },
    ],
  };
  const lay = layout(graph);
  const { memory, process } = await instantiate(graph);
  const ringBase = lay.regions.messageRings.slots["ping"]!.base;
  const headerView = new Int32Array(memory.buffer, ringBase, 3);
  // Queue 3 fires (head = 3, no slot contents = void payload)
  headerView[0] = 3;
  process();
  // drain advances tail to 3; handler fires, state = 1
  expect(headerView[1]).toBe(3);
  const fireView = new Int32Array(memory.buffer, lay.regions.states.slots["fireCount"]!, 1);
  expect(fireView[0]).toBe(1);
});

test("`emit` throws on unknown message slot in messageOnReceive", async () => {
  const graph: CapturedGraph = {
    declarations: [],
    statements: [
      {
        kind: "messageOnReceive",
        name: "ghost",
        body: [],
      },
    ],
  };
  await expect(emit(graph, layout(graph))).rejects.toThrow(/unknown message slot.*ghost/);
});

// ─────────────────────────────────────────────────────────────────────────
// DSL primitive operators (`01-dsl.md` §2.1) — emit lowering + e2e.
// Each operator: confirm the AST node -> binaryen IR lowering via WAT,
// then verify numeric results via memory I/O.
// ─────────────────────────────────────────────────────────────────────────

test("`emitExpression(add)` lowers to `f32.add`", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  const ref = emitExpression(
    {
      kind: "add",
      type: "f32",
      lhs: { kind: "literal", type: "f32", value: 2 },
      rhs: { kind: "literal", type: "f32", value: 3 },
    },
    emptyLayout,
    mod,
    binaryen,
  );
  expect(watOfExpression(mod, binaryen, ref, binaryen.f32)).toContain("(f32.add");
  mod.dispose();
});

test("`emit(add)` e2e: 2 + 3 = 5", async () => {
  const stored = await runStoreAndRead(
    makeStoreValueGraph({
      kind: "add",
      type: "f32",
      lhs: { kind: "literal", type: "f32", value: 2 },
      rhs: { kind: "literal", type: "f32", value: 3 },
    }),
  );
  expect(stored).toBe(5);
});

test("`emit(add)` e2e: 2 + (-5) = -3 (negative value)", async () => {
  const stored = await runStoreAndRead(
    makeStoreValueGraph({
      kind: "add",
      type: "f32",
      lhs: { kind: "literal", type: "f32", value: 2 },
      rhs: { kind: "literal", type: "f32", value: -5 },
    }),
  );
  expect(stored).toBe(-3);
});

test("`emitExpression(sub)` lowers to `f32.sub`", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  const ref = emitExpression(
    {
      kind: "sub",
      type: "f32",
      lhs: { kind: "literal", type: "f32", value: 5 },
      rhs: { kind: "literal", type: "f32", value: 3 },
    },
    emptyLayout,
    mod,
    binaryen,
  );
  expect(watOfExpression(mod, binaryen, ref, binaryen.f32)).toContain("(f32.sub");
  mod.dispose();
});

test("`emit(sub)` e2e: 5 - 3 = 2", async () => {
  const stored = await runStoreAndRead(
    makeStoreValueGraph({
      kind: "sub",
      type: "f32",
      lhs: { kind: "literal", type: "f32", value: 5 },
      rhs: { kind: "literal", type: "f32", value: 3 },
    }),
  );
  expect(stored).toBe(2);
});

test("`emit(sub)` e2e: 3 - 5 = -2 (negative value)", async () => {
  const stored = await runStoreAndRead(
    makeStoreValueGraph({
      kind: "sub",
      type: "f32",
      lhs: { kind: "literal", type: "f32", value: 3 },
      rhs: { kind: "literal", type: "f32", value: 5 },
    }),
  );
  expect(stored).toBe(-2);
});

test("`emitExpression(div)` lowers to `f32.div`", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  const ref = emitExpression(
    {
      kind: "div",
      type: "f32",
      lhs: { kind: "literal", type: "f32", value: 10 },
      rhs: { kind: "literal", type: "f32", value: 2 },
    },
    emptyLayout,
    mod,
    binaryen,
  );
  expect(watOfExpression(mod, binaryen, ref, binaryen.f32)).toContain("(f32.div");
  mod.dispose();
});

test("`emit(div)` e2e: 10 / 2 = 5", async () => {
  const stored = await runStoreAndRead(
    makeStoreValueGraph({
      kind: "div",
      type: "f32",
      lhs: { kind: "literal", type: "f32", value: 10 },
      rhs: { kind: "literal", type: "f32", value: 2 },
    }),
  );
  expect(stored).toBe(5);
});

test("`emit(div)` e2e: 1 / 0 = +Infinity (non-trapping)", async () => {
  const stored = await runStoreAndRead(
    makeStoreValueGraph({
      kind: "div",
      type: "f32",
      lhs: { kind: "literal", type: "f32", value: 1 },
      rhs: { kind: "literal", type: "f32", value: 0 },
    }),
  );
  expect(stored).toBe(Number.POSITIVE_INFINITY);
});

test("`emit(div)` e2e: -1 / 0 = -Infinity", async () => {
  const stored = await runStoreAndRead(
    makeStoreValueGraph({
      kind: "div",
      type: "f32",
      lhs: { kind: "literal", type: "f32", value: -1 },
      rhs: { kind: "literal", type: "f32", value: 0 },
    }),
  );
  expect(stored).toBe(Number.NEGATIVE_INFINITY);
});

test("`emitExpression(min)` lowers to `f32.min`", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  const ref = emitExpression(
    {
      kind: "min",
      type: "f32",
      lhs: { kind: "literal", type: "f32", value: 3 },
      rhs: { kind: "literal", type: "f32", value: 5 },
    },
    emptyLayout,
    mod,
    binaryen,
  );
  expect(watOfExpression(mod, binaryen, ref, binaryen.f32)).toContain("(f32.min");
  mod.dispose();
});

test("`emit(min)` e2e: min(3, 5) = 3 / min(5, 3) = 3", async () => {
  const lo = await runStoreAndRead(
    makeStoreValueGraph({
      kind: "min",
      type: "f32",
      lhs: { kind: "literal", type: "f32", value: 3 },
      rhs: { kind: "literal", type: "f32", value: 5 },
    }),
  );
  expect(lo).toBe(3);
  const hi = await runStoreAndRead(
    makeStoreValueGraph({
      kind: "min",
      type: "f32",
      lhs: { kind: "literal", type: "f32", value: 5 },
      rhs: { kind: "literal", type: "f32", value: 3 },
    }),
  );
  expect(hi).toBe(3);
});

test("`emit(min)` e2e: min(-1, 2) = -1 (mixed negative value)", async () => {
  const stored = await runStoreAndRead(
    makeStoreValueGraph({
      kind: "min",
      type: "f32",
      lhs: { kind: "literal", type: "f32", value: -1 },
      rhs: { kind: "literal", type: "f32", value: 2 },
    }),
  );
  expect(stored).toBe(-1);
});

test("`emitExpression(neg)` lowers to `f32.neg`", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  const ref = emitExpression(
    { kind: "neg", type: "f32", value: { kind: "literal", type: "f32", value: 5 } },
    emptyLayout,
    mod,
    binaryen,
  );
  expect(watOfExpression(mod, binaryen, ref, binaryen.f32)).toContain("(f32.neg");
  mod.dispose();
});

test("`emit(neg)` e2e: neg(0.5) = -0.5 / neg(-0.5) = 0.5", async () => {
  const pos = await runStoreAndRead(
    makeStoreValueGraph({
      kind: "neg",
      type: "f32",
      value: { kind: "literal", type: "f32", value: 0.5 },
    }),
  );
  expect(pos).toBe(-0.5);
  const negv = await runStoreAndRead(
    makeStoreValueGraph({
      kind: "neg",
      type: "f32",
      value: { kind: "literal", type: "f32", value: -0.5 },
    }),
  );
  expect(negv).toBe(0.5);
});

test("`emitExpression(sqrt)` lowers to `f32.sqrt`", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  const ref = emitExpression(
    { kind: "sqrt", type: "f32", value: { kind: "literal", type: "f32", value: 4 } },
    emptyLayout,
    mod,
    binaryen,
  );
  expect(watOfExpression(mod, binaryen, ref, binaryen.f32)).toContain("(f32.sqrt");
  mod.dispose();
});

test("`emit(sqrt)` e2e: sqrt(4) = 2 / sqrt(2) ≈ 1.4142", async () => {
  const four = await runStoreAndRead(
    makeStoreValueGraph({
      kind: "sqrt",
      type: "f32",
      value: { kind: "literal", type: "f32", value: 4 },
    }),
  );
  expect(four).toBe(2);
  const two = await runStoreAndRead(
    makeStoreValueGraph({
      kind: "sqrt",
      type: "f32",
      value: { kind: "literal", type: "f32", value: 2 },
    }),
  );
  expect(two).toBeCloseTo(Math.SQRT2, 6);
});

test("`emit(sqrt)` e2e: sqrt(-1) = NaN (non-trapping)", async () => {
  const stored = await runStoreAndRead(
    makeStoreValueGraph({
      kind: "sqrt",
      type: "f32",
      value: { kind: "literal", type: "f32", value: -1 },
    }),
  );
  expect(Number.isNaN(stored)).toBe(true);
});

test("`emitExpression(floor)` lowers to `f32.floor`", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  const ref = emitExpression(
    { kind: "floor", type: "f32", value: { kind: "literal", type: "f32", value: 1.7 } },
    emptyLayout,
    mod,
    binaryen,
  );
  expect(watOfExpression(mod, binaryen, ref, binaryen.f32)).toContain("(f32.floor");
  mod.dispose();
});

test("`emit(floor)` e2e: floor(1.7)=1 / floor(-1.2)=-2 / floor(3)=3", async () => {
  const a = await runStoreAndRead(
    makeStoreValueGraph({
      kind: "floor",
      type: "f32",
      value: { kind: "literal", type: "f32", value: 1.7 },
    }),
  );
  expect(a).toBe(1);
  const b = await runStoreAndRead(
    makeStoreValueGraph({
      kind: "floor",
      type: "f32",
      value: { kind: "literal", type: "f32", value: -1.2 },
    }),
  );
  expect(b).toBe(-2);
  const c = await runStoreAndRead(
    makeStoreValueGraph({
      kind: "floor",
      type: "f32",
      value: { kind: "literal", type: "f32", value: 3 },
    }),
  );
  expect(c).toBe(3);
});

test("`emitExpression(ceil)` lowers to `f32.ceil`", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  const ref = emitExpression(
    { kind: "ceil", type: "f32", value: { kind: "literal", type: "f32", value: 1.2 } },
    emptyLayout,
    mod,
    binaryen,
  );
  expect(watOfExpression(mod, binaryen, ref, binaryen.f32)).toContain("(f32.ceil");
  mod.dispose();
});

test("`emit(ceil)` e2e: ceil(1.2)=2 / ceil(-1.7)=-1 / ceil(3)=3", async () => {
  const a = await runStoreAndRead(
    makeStoreValueGraph({
      kind: "ceil",
      type: "f32",
      value: { kind: "literal", type: "f32", value: 1.2 },
    }),
  );
  expect(a).toBe(2);
  const b = await runStoreAndRead(
    makeStoreValueGraph({
      kind: "ceil",
      type: "f32",
      value: { kind: "literal", type: "f32", value: -1.7 },
    }),
  );
  expect(b).toBe(-1);
  const c = await runStoreAndRead(
    makeStoreValueGraph({
      kind: "ceil",
      type: "f32",
      value: { kind: "literal", type: "f32", value: 3 },
    }),
  );
  expect(c).toBe(3);
});

// Comparison operator e2e: result is i32 (bool 0/1); stored in a state.i32 slot and read back.
async function runCompareAndRead(value: AstNode): Promise<number> {
  const graph: CapturedGraph = {
    declarations: [{ kind: "state", name: "c", type: "i32", initial: 0 }],
    statements: [{ kind: "stateStore", type: "i32", name: "c", value }],
  };
  const lay = layout(graph);
  const wasm = await emit(graph, lay);
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  (instance.exports["process"] as () => void)();
  return new Int32Array(memory.buffer, lay.regions.states.slots["c"]!, 1)[0]!;
}

function cmp(
  // Scalar binary kinds with a variable operand `type` (numeric comparisons
  // etc.). Excludes `"and"` / `"or"` because their operand type is fixed to
  // `"bool"` — this helper always hard-codes `type: "f32"` and would produce an
  // impossible AstNode for a bool-fixed kind.
  kind: Exclude<
    Extract<AstNode, { lhs: AstNode; rhs: AstNode; type: ScalarType }>["kind"],
    "and" | "or"
  >,
  a: number,
  b: number,
): AstNode {
  return {
    kind,
    type: "f32",
    lhs: { kind: "literal", type: "f32", value: a },
    rhs: { kind: "literal", type: "f32", value: b },
  };
}

test("`emitExpression(eq)` lowers to `f32.eq`", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  const ref = emitExpression(cmp("eq", 3, 3), emptyLayout, mod, binaryen);
  expect(watOfExpression(mod, binaryen, ref, binaryen.i32)).toContain("(f32.eq");
  mod.dispose();
});

test("`emit(eq)` e2e: 3==3 → 1 / 3==5 → 0 / NaN==NaN → 0", async () => {
  expect(await runCompareAndRead(cmp("eq", 3, 3))).toBe(1);
  expect(await runCompareAndRead(cmp("eq", 3, 5))).toBe(0);
  expect(await runCompareAndRead(cmp("eq", Number.NaN, Number.NaN))).toBe(0);
});

test("`emitExpression(lt)` lowers to `f32.lt`", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  const ref = emitExpression(cmp("lt", 3, 5), emptyLayout, mod, binaryen);
  expect(watOfExpression(mod, binaryen, ref, binaryen.i32)).toContain("(f32.lt");
  mod.dispose();
});

test("`emit(lt)` e2e: 3<5 → 1 / 5<3 → 0 / 3<3 → 0 (equal-value boundary)", async () => {
  expect(await runCompareAndRead(cmp("lt", 3, 5))).toBe(1);
  expect(await runCompareAndRead(cmp("lt", 5, 3))).toBe(0);
  expect(await runCompareAndRead(cmp("lt", 3, 3))).toBe(0);
});

test("`emitExpression(gt)` lowers to `f32.gt`", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  const ref = emitExpression(cmp("gt", 5, 3), emptyLayout, mod, binaryen);
  expect(watOfExpression(mod, binaryen, ref, binaryen.i32)).toContain("(f32.gt");
  mod.dispose();
});

test("`emit(gt)` e2e: 5>3 → 1 / 3>5 → 0 / 3>3 → 0 (equal-value boundary)", async () => {
  expect(await runCompareAndRead(cmp("gt", 5, 3))).toBe(1);
  expect(await runCompareAndRead(cmp("gt", 3, 5))).toBe(0);
  expect(await runCompareAndRead(cmp("gt", 3, 3))).toBe(0);
});

test("`emitExpression(lte)` lowers to `f32.le`", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  const ref = emitExpression(cmp("lte", 3, 5), emptyLayout, mod, binaryen);
  expect(watOfExpression(mod, binaryen, ref, binaryen.i32)).toContain("(f32.le");
  mod.dispose();
});

test("`emit(lte)` e2e: 3<=3 → 1 / 3<=5 → 1 / 5<=3 → 0 (equal-value boundary)", async () => {
  expect(await runCompareAndRead(cmp("lte", 3, 3))).toBe(1);
  expect(await runCompareAndRead(cmp("lte", 3, 5))).toBe(1);
  expect(await runCompareAndRead(cmp("lte", 5, 3))).toBe(0);
});

test("`emitExpression(gte)` lowers to `f32.ge`", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  const ref = emitExpression(cmp("gte", 5, 3), emptyLayout, mod, binaryen);
  expect(watOfExpression(mod, binaryen, ref, binaryen.i32)).toContain("(f32.ge");
  mod.dispose();
});

test("`emit(gte)` e2e: 3>=3 → 1 / 5>=3 → 1 / 3>=5 → 0 (equal-value boundary)", async () => {
  expect(await runCompareAndRead(cmp("gte", 3, 3))).toBe(1);
  expect(await runCompareAndRead(cmp("gte", 5, 3))).toBe(1);
  expect(await runCompareAndRead(cmp("gte", 3, 5))).toBe(0);
});

function clampAst(x: number, lo: number, hi: number): AstNode {
  return {
    kind: "clamp",
    type: "f32",
    x: { kind: "literal", type: "f32", value: x },
    lo: { kind: "literal", type: "f32", value: lo },
    hi: { kind: "literal", type: "f32", value: hi },
  };
}

test("`emitExpression(clamp)` lowers to nested `f32.min`/`f32.max`", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  const ref = emitExpression(clampAst(5, 0, 1), emptyLayout, mod, binaryen);
  const wat = watOfExpression(mod, binaryen, ref, binaryen.f32);
  expect(wat).toContain("(f32.min");
  expect(wat).toContain("(f32.max");
  mod.dispose();
});

test("`emit(clamp)` e2e: within range / below lo / above hi", async () => {
  expect(await runStoreAndRead(makeStoreValueGraph(clampAst(0.5, 0, 1)))).toBe(0.5);
  expect(await runStoreAndRead(makeStoreValueGraph(clampAst(-1, 0, 1)))).toBe(0);
  expect(await runStoreAndRead(makeStoreValueGraph(clampAst(5, 0, 1)))).toBe(1);
});

test("`emit(clamp)` e2e: degenerate case lo > hi returns hi", async () => {
  expect(await runStoreAndRead(makeStoreValueGraph(clampAst(0.5, 1, 0)))).toBe(0);
});

function selectAst(cond: AstNode, then: number, else_: number): AstNode {
  return {
    kind: "select",
    type: "f32",
    cond,
    ifTrue: { kind: "literal", type: "f32", value: then },
    ifFalse: { kind: "literal", type: "f32", value: else_ },
  };
}

test("`emitExpression(select)` lowers to WASM `select`", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  const ref = emitExpression(selectAst(cmp("gt", 5, 3), 10, 20), emptyLayout, mod, binaryen);
  expect(watOfExpression(mod, binaryen, ref, binaryen.f32)).toContain("(select");
  mod.dispose();
});

test("`emit(select)` e2e: cond true → then(10) / cond false → else(20)", async () => {
  const t = await runStoreAndRead(makeStoreValueGraph(selectAst(cmp("gt", 5, 3), 10, 20)));
  expect(t).toBe(10);
  const f = await runStoreAndRead(makeStoreValueGraph(selectAst(cmp("gt", 3, 5), 10, 20)));
  expect(f).toBe(20);
});

test("`emit(select)` e2e: bool literal branch stored into state.bool (canonical select(cond, true, gate.read()))", async () => {
  // cond true -> picks bool literal `true` (=1). The bool branch literal must lower to i32.const in emit,
  // so the entire select evaluates as i32 and can be written into state.bool.
  const graph: CapturedGraph = {
    declarations: [{ kind: "state", name: "gate", type: "bool", initial: false }],
    statements: [
      {
        kind: "stateStore",
        type: "bool",
        name: "gate",
        value: {
          kind: "select",
          type: "bool",
          cond: { kind: "literal", type: "i32", value: 1 },
          ifTrue: { kind: "literal", type: "bool", value: 1 },
          ifFalse: { kind: "stateLoad", type: "bool", name: "gate" },
        },
      },
    ],
  };
  const lay = layout(graph);
  const wasm = await emit(graph, lay);
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  proc();
  const view = new Int32Array(memory.buffer, lay.regions.states.slots["gate"]!, 1);
  expect(view[0]).toBe(1);
});

function fracAst(value: AstNode): AstNode {
  return { kind: "frac", type: "f32", value };
}

test("`emitExpression(frac)` lowers to `f32.sub` + `f32.floor` (via temp local)", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  const ref = emitExpression(
    fracAst({ kind: "literal", type: "f32", value: 1.25 }),
    emptyLayout,
    mod,
    binaryen,
  );
  const wat = watOfExpression(mod, binaryen, ref, binaryen.f32);
  expect(wat).toContain("(f32.sub");
  expect(wat).toContain("(f32.floor");
  mod.dispose();
});

test("`emit(frac)` e2e: frac(1.25)=0.25 / frac(3)=0", async () => {
  expect(
    await runStoreAndRead(
      makeStoreValueGraph(fracAst({ kind: "literal", type: "f32", value: 1.25 })),
    ),
  ).toBe(0.25);
  expect(
    await runStoreAndRead(makeStoreValueGraph(fracAst({ kind: "literal", type: "f32", value: 3 }))),
  ).toBe(0);
});

test("`emit(frac)` e2e: frac(-0.3) ≈ 0.7 (GLSL fract semantics, result in [0,1))", async () => {
  const v = await runStoreAndRead(
    makeStoreValueGraph(fracAst({ kind: "literal", type: "f32", value: -0.3 })),
  );
  expect(v).toBeCloseTo(0.7, 5);
});

test("`emit(frac)` e2e: nested frac(frac(1.75)) = 0.75 (shared local survives nesting)", async () => {
  const v = await runStoreAndRead(
    makeStoreValueGraph(fracAst(fracAst({ kind: "literal", type: "f32", value: 1.75 }))),
  );
  expect(v).toBeCloseTo(0.75, 5);
});

test("`emitExpression(mod)` lowers to sub/trunc/div (JS % equivalent)", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  const ref = emitExpression(cmp("mod", 7, 3), emptyLayout, mod, binaryen);
  const wat = watOfExpression(mod, binaryen, ref, binaryen.f32);
  expect(wat).toContain("(f32.sub");
  expect(wat).toContain("(f32.trunc");
  expect(wat).toContain("(f32.div");
  mod.dispose();
});

test("`emit(mod)` e2e: 7%3=1 / 7.5%2=1.5", async () => {
  expect(await runStoreAndRead(makeStoreValueGraph(cmp("mod", 7, 3)))).toBe(1);
  expect(await runStoreAndRead(makeStoreValueGraph(cmp("mod", 7.5, 2)))).toBe(1.5);
});

test("`emit(mod)` e2e: negative dividend -7%3=-1 / 7%-3=1 (JS % sign follows dividend)", async () => {
  expect(await runStoreAndRead(makeStoreValueGraph(cmp("mod", -7, 3)))).toBe(-1);
  expect(await runStoreAndRead(makeStoreValueGraph(cmp("mod", 7, -3)))).toBe(1);
});

test("`emit(mod)` e2e: 5%0 = NaN (= JS x%0)", async () => {
  const v = await runStoreAndRead(makeStoreValueGraph(cmp("mod", 5, 0)));
  expect(Number.isNaN(v)).toBe(true);
});

test("`emit(mod)` e2e: nested mod(mod(10,7),2)=1 (shared local safety)", async () => {
  const nested: AstNode = {
    kind: "mod",
    type: "f32",
    lhs: cmp("mod", 10, 7),
    rhs: { kind: "literal", type: "f32", value: 2 },
  };
  expect(await runStoreAndRead(makeStoreValueGraph(nested))).toBe(1);
});

test("`emit(mod)` e2e: infinite divisor returns finite dividend (JS 5%Infinity===5, no 0*Inf NaN)", async () => {
  // Inf flowing into the divisor (e.g. from div-by-zero) must not corrupt a finite dividend.
  expect(await runStoreAndRead(makeStoreValueGraph(cmp("mod", 5, Number.POSITIVE_INFINITY)))).toBe(
    5,
  );
  expect(await runStoreAndRead(makeStoreValueGraph(cmp("mod", -5, Number.POSITIVE_INFINITY)))).toBe(
    -5,
  );
  expect(await runStoreAndRead(makeStoreValueGraph(cmp("mod", 5, Number.NEGATIVE_INFINITY)))).toBe(
    5,
  );
});

test("`emit(mod)` e2e: infinite dividend produces NaN (JS Inf%5 / Inf%Inf)", async () => {
  const infMod5 = await runStoreAndRead(
    makeStoreValueGraph(cmp("mod", Number.POSITIVE_INFINITY, 5)),
  );
  expect(Number.isNaN(infMod5)).toBe(true);
  const infModInf = await runStoreAndRead(
    makeStoreValueGraph(cmp("mod", Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)),
  );
  expect(Number.isNaN(infModInf)).toBe(true);
});

function mathAst(kind: "sin" | "cos" | "tan" | "exp" | "log" | "tanh", x: number): AstNode {
  return { kind, type: "f32", value: { kind: "literal", type: "f32", value: x } };
}

test("`emit(sin)` e2e: matches Math.sin with |error| < 1e-4 (grid)", async () => {
  const xs = [
    0,
    Math.PI / 6,
    Math.PI / 4,
    Math.PI / 3,
    Math.PI / 2,
    Math.PI,
    -Math.PI / 2,
    -Math.PI / 4,
    1,
    2,
    -3,
    5,
    10,
  ];
  for (const x of xs) {
    const got = await runStoreAndRead(makeStoreValueGraph(mathAst("sin", x)));
    expect(Math.abs(got - Math.sin(x))).toBeLessThan(1e-4);
  }
});

test("`emit(sin)` e2e: large argument sin(100) approximated via range reduction (within f32 precision)", async () => {
  const got = await runStoreAndRead(makeStoreValueGraph(mathAst("sin", 100)));
  expect(Math.abs(got - Math.sin(100))).toBeLessThan(1e-3);
});

test("`emit(cos)` e2e: matches Math.cos with |error| < 1e-4 (grid)", async () => {
  const xs = [
    0,
    Math.PI / 6,
    Math.PI / 4,
    Math.PI / 3,
    Math.PI / 2,
    Math.PI,
    -Math.PI / 2,
    1,
    2,
    -3,
    5,
  ];
  for (const x of xs) {
    const got = await runStoreAndRead(makeStoreValueGraph(mathAst("cos", x)));
    expect(Math.abs(got - Math.cos(x))).toBeLessThan(1e-4);
  }
});

test("`emit(tan)` e2e: matches Math.tan at non-singular points", async () => {
  for (const x of [0, Math.PI / 6, Math.PI / 4, Math.PI / 3, -Math.PI / 4, -Math.PI / 6]) {
    const got = await runStoreAndRead(makeStoreValueGraph(mathAst("tan", x)));
    expect(Math.abs(got - Math.tan(x))).toBeLessThan(1e-3);
  }
});

test("`emit(tan)` e2e: near pi/2 produces a large finite value (non-trapping, no NaN)", async () => {
  const got = await runStoreAndRead(makeStoreValueGraph(mathAst("tan", 1.5)));
  expect(Number.isNaN(got)).toBe(false);
  expect(Math.abs(got)).toBeGreaterThan(10);
});

test("`emit(exp)` e2e: relative error < 1e-4 vs Math.exp (grid)", async () => {
  for (const x of [-20, -5, -1, -0.5, 0, 0.5, 1, 2, 5, 10, 20, 30]) {
    const got = await runStoreAndRead(makeStoreValueGraph(mathAst("exp", x)));
    expect(Math.abs(got - Math.exp(x)) / Math.exp(x)).toBeLessThan(1e-4);
  }
});

test("`emit(log)` e2e: matches Math.log with |error| < 1e-4 (grid)", async () => {
  for (const x of [0.001, 0.1, 0.5, 1, Math.E, 2, 10, 100, 1000, 1e6]) {
    const got = await runStoreAndRead(makeStoreValueGraph(mathAst("log", x)));
    expect(Math.abs(got - Math.log(x))).toBeLessThan(1e-4);
  }
});

test("`emit(log)` e2e: out-of-domain follows Math.log (log(0)->-Inf / log(-1)->NaN, non-trapping)", async () => {
  const zero = await runStoreAndRead(makeStoreValueGraph(mathAst("log", 0)));
  expect(zero).toBe(Number.NEGATIVE_INFINITY);
  const neg = await runStoreAndRead(makeStoreValueGraph(mathAst("log", -1)));
  expect(Number.isNaN(neg)).toBe(true);
});

test("`emit(log)` e2e: special values follow Math.log (log(NaN)->NaN / log(+Inf)->+Inf)", async () => {
  // NaN: both x>0 and x<0 are false, so it falls into the inner select path -> must not become -Inf.
  const nan = await runStoreAndRead(makeStoreValueGraph(mathAst("log", Number.NaN)));
  expect(Number.isNaN(nan)).toBe(true);
  // +Inf: x>0 is true, so the bit-decomposition approximation (finite value near 128*ln2) must not be returned.
  const posInf = await runStoreAndRead(
    makeStoreValueGraph(mathAst("log", Number.POSITIVE_INFINITY)),
  );
  expect(posInf).toBe(Number.POSITIVE_INFINITY);
});

test("`emit(log)` e2e: subnormal input follows Math.log (normalized to normal range before decomposition)", async () => {
  // For 0 < x < FLT_MIN (~1.1755e-38), exponent field=0 breaks naive bit decomposition:
  // log(1e-45) would come out ~-88 instead of ~-103. Constants are rounded to f32,
  // so comparison is against Math.log of the fround'd value.
  for (const x of [1e-45, 1e-40, 5e-39, 1e-38]) {
    const ref = Math.log(Math.fround(x));
    const got = await runStoreAndRead(makeStoreValueGraph(mathAst("log", x)));
    expect(Math.abs(got - ref)).toBeLessThan(1e-2);
  }
});

test("`emit(tanh)` e2e: matches Math.tanh with |error| < 1e-4 (grid)", async () => {
  for (const x of [0, 0.5, 1, -1, 2, -2, 3, -3, 6]) {
    const got = await runStoreAndRead(makeStoreValueGraph(mathAst("tanh", x)));
    expect(Math.abs(got - Math.tanh(x))).toBeLessThan(1e-4);
  }
});

test("`emit(tanh)` e2e: large inputs saturate to ±1 (no Inf/Inf)", async () => {
  expect(await runStoreAndRead(makeStoreValueGraph(mathAst("tanh", 10)))).toBeCloseTo(1, 4);
  expect(await runStoreAndRead(makeStoreValueGraph(mathAst("tanh", -10)))).toBeCloseTo(-1, 4);
});

test("`emit(tanh)` e2e: nested tanh(sin(0.5)) (walker collects inner sin)", async () => {
  const nested: AstNode = {
    kind: "tanh",
    type: "f32",
    value: { kind: "sin", type: "f32", value: { kind: "literal", type: "f32", value: 0.5 } },
  };
  const got = await runStoreAndRead(makeStoreValueGraph(nested));
  expect(Math.abs(got - Math.tanh(Math.sin(0.5)))).toBeLessThan(1e-3);
});

// select with a constant bool cond (`select(true/false, a, b)`) must branch without
// throwing in emit (P2 fix, reported by @codex on #6). bool is internally i32,
// so cond is lifted to i32 literal 0/1.
test("`emit(select)` e2e: select(true, 10, 20) → 10 / select(false, 10, 20) → 20", async () => {
  const t = await runStoreAndRead(makeStoreValueGraph(unwrapAst(select(true, 10, 20))));
  expect(t).toBe(10);
  const f = await runStoreAndRead(makeStoreValueGraph(unwrapAst(select(false, 10, 20))));
  expect(f).toBe(20);
});

// exp's 2^k bit-pack is clamped outside the exponent range (overflow->+Inf / underflow->0).
// Reported by @codex on #6.
test("`emit(exp)` e2e: large input overflows to +Inf / large negative input underflows to 0", async () => {
  expect(await runStoreAndRead(makeStoreValueGraph(mathAst("exp", 90)))).toBe(
    Number.POSITIVE_INFINITY,
  );
  expect(await runStoreAndRead(makeStoreValueGraph(mathAst("exp", -100)))).toBe(0);
});

test("`emit(tanh)` e2e: large negative input tanh(-50) ≈ -1 (via exp underflow path)", async () => {
  const got = await runStoreAndRead(makeStoreValueGraph(mathAst("tanh", -50)));
  expect(got).toBeCloseTo(-1, 4);
});
