/**
 * Behavior of the WASM emission stage (= plan Q-F 引 数 ナ シ + 固 定 region
 * WASM export、 plan Q-D stage 別 internal module の 1 つ)。
 *
 * binaryen を dynamic import し て AST → binaryen IR lower → WASM binary
 * を 返 す。 2 層 test:
 * - unit = emitExpression / emitStatement 単 体 invoke + binaryen module
 *   wrap + emitText で WAT 全 体 を inline snapshot で fix (= schemaHash
 *   と 同 「絶 対 変 わ ら な い」 regression check path、 binaryen
 *   version 更 新 / lower 戦 略 変 更 で snapshot fail = 意 図 的 retract)
 * - e2e = emit ⇒ WebAssembly.instantiate ⇒ memory に 入 力 set ⇒ process()
 *   ⇒ memory か ら 出 力 read で 期 待 値 確 認
 */

import { expect, test } from "vite-plus/test";

import type { AstNode, CapturedGraph } from "./ast.ts";
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
// Unit tests: emitExpression / emitStatement の 中 間 IR 形 (WAT 全 体 一 致)
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
// E2E tests: emit → WebAssembly.compile → instantiate → memory I/O
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

test("`emit(monoLiteralWrite)` = top-level literal write が memory に 反 映 (= 1 sample)", async () => {
  const lay = layout(monoLiteralWriteGraph);
  const { memory, process } = await instantiate(monoLiteralWriteGraph);
  process();
  const out = new Float32Array(memory.buffer, lay.regions.ioScratch.outputs["main"]!, 128);
  expect(out[0]).toBe(0.5);
  expect(out[1]).toBe(0); // 他 sample は zero
});

test("`emit(monoPassthrough)` = input が そ の ま ま output へ copy さ れ る", async () => {
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

test("`emit(stereoGain)` = (input × gain) が channel ご と に output へ 書 か れ る", async () => {
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
  // 2 page = 131072 byte 確 保 さ れ て いる こ と (= 130 input × 512 = 66560 > 65536)
  expect(memory.buffer.byteLength).toBe(131072);
});

test("`emit` throws on unknown audioInput port (= layout に な し)", async () => {
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
// stateLoad / stateStore = Phase 7 sub-phase 7.1 stub (= ast.ts に kind 追 加、
// emit は sub-phase 7.3 で fill)。 stub throw + statement / expression
// position guard が 走 る こ と を 確 認。
// ─────────────────────────────────────────────────────────────────────────

test("`emitExpression(stateLoad)` throws sub-phase 7.3 stub marker", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  expect(() =>
    emitExpression({ kind: "stateLoad", type: "f32", name: "x" }, emptyLayout, mod, binaryen),
  ).toThrow(/sub-phase 7\.3/);
  mod.dispose();
});

test("`emitStatement(stateStore)` throws sub-phase 7.3 stub marker", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  expect(() =>
    emitStatement(
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
  ).toThrow(/sub-phase 7\.3/);
  mod.dispose();
});

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
