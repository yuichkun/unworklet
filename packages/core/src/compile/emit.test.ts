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
// stateLoad / stateStore = Phase 7 sub-phase 7.1 (= state.<type> plain
// factory の load / store WASM emit + subnormal flush guard for f32/f64)。
// 5 scalar type 全 round-trip + subnormal guard 境 界 + unknown slot reject。
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

// state round-trip 用 fixture builder = store literal → forSample で 全 sample
// に load 結 果 を write、 process() 後 output[0] が 期 待 値 で あ る こ と を 確 認。
function makeStateRoundtripGraph(
  type: "f32" | "f64" | "i32" | "i64" | "bool",
  storeValue: AstNode,
  initial: number | bigint | boolean,
): CapturedGraph {
  // f64 / i64 を audio output に そ の ま ま 流 せ な い (= audio output は f32) =
  // state ↔ state round-trip で 確 認 (= store した値 を 別 state に load → store)。
  // f32 / i32 / bool は audio output (= f32) に 流 し て 直 接 観 測。
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
                : // i32 / bool は内 部 i32 = audio output (= f32) に そ の ま ま 流 す と
                  // type mismatch、 ただ unit test の memory I/O で 直 接 観 測 す る
                  // path は audio output 経 由 ナ シ。 i32 / bool 用 fixture は 別 path
                  // で 組 む (= makeStateMemoryRoundtripGraph で 直 接 memory dump)。
                  { kind: "literal", type: "f32", value: 0 },
          },
        ],
      },
    ],
  };
}

test("`emit` state.f32 round-trip = store value が load で 取 れ る", async () => {
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

test("`emit` state.f32 subnormal flush = 1e-40 store → load で 0", async () => {
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

test("`emit` state.f32 subnormal threshold = 1e-29 store → load で そ の ま ま (= 境 界 超 え 保 持)", async () => {
  const graph = makeStateRoundtripGraph("f32", { kind: "literal", type: "f32", value: 1e-29 }, 0);
  const lay = layout(graph);
  const wasm = await emit(graph, lay);
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  proc();
  const out = new Float32Array(memory.buffer, lay.regions.ioScratch.outputs["main"]!, 128);
  // 1e-29 は f32 で 表 現 可 能 = Math.fround で 同 値 近 似 (= subnormal range の 外)
  expect(out[0]).toBeCloseTo(Math.fround(1e-29), 35);
  expect(out[0]).not.toBe(0);
});

test("`emit` state.f64 round-trip + subnormal flush via memory dump", async () => {
  // f64 は audio output (= f32) に 流 せ な い = state ↔ state round-trip + memory
  // 直 接 read で 確 認。 src に 1e-40 store → guard で 0 flush → dst に copy → dst slot を read。
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
  // 1e-40 store → subnormal guard で 0 に flush
  expect(srcView[0]).toBe(0);
  expect(dstView[0]).toBe(0);
});

test("`emit` state.f64 subnormal threshold = 1e-29 store で そ の ま ま", async () => {
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

test("`emit` state.i32 round-trip via memory dump (= subnormal guard 不 適 用)", async () => {
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
  // i64 は audio output に 流 せ な い = state ↔ state round-trip + memory 直 接 read。
  // ただ i64 literal は AstNode kind=literal で value が number 型 = i64 を 表 現 困 難 =
  // 0 store の 単 純 round-trip だ け で kind=i64 case 経 路 を hit 確 認 (= layout は 8 byte
  // slot allocate、 emit は i64.store 経 由)。
  const graph: CapturedGraph = {
    declarations: [{ kind: "state", name: "x", type: "i64", initial: 0n }],
    statements: [
      {
        kind: "stateStore",
        type: "i64",
        name: "x",
        // literal i64 の 直 接 表 現 path は ast.ts の literal 制 約 (= value: number) で
        // 限 定 的 = stateLoad の round-trip で 「初 期 値 0 を そ の ま ま 戻 す」 path。
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
  expect(view[0]).toBe(0n); // 初 期 memory zero、 load → store で そ の ま ま
});

test("`emit` state.bool round-trip via memory dump (= 内 部 i32 表 現)", async () => {
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

test("`emitExpression(literal i64)` throws 後 続 phase stub marker", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  expect(() =>
    emitExpression({ kind: "literal", type: "i64", value: 0 }, emptyLayout, mod, binaryen),
  ).toThrow(/i64 literal emission not implemented/);
  mod.dispose();
});

test("`emitExpression(literal bool)` throws 後 続 phase stub marker", async () => {
  const binaryen = await loadBinaryen();
  const mod = makeMod(binaryen);
  expect(() =>
    emitExpression({ kind: "literal", type: "bool", value: 0 }, emptyLayout, mod, binaryen),
  ).toThrow(/bool literal emission not implemented/);
  mod.dispose();
});

// ─────────────────────────────────────────────────────────────────────────
// subnormal guard 振 る 舞 い 仕 様 (= spec-state-store-behavior.md)
// 値 source の バ リ エ ー シ ョ ン × forSample 内/外 × 境 界 値 × 特 殊 値 で
// guard が 一 律 適 用 さ れ る 振 る 舞 い を 全 case 担 保。
// ─────────────────────────────────────────────────────────────────────────

// 値 source 別 = store value AST を build 直 接 + state.f32 round-trip + memory dump で 結 果 確 認
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

test("subnormal guard: literal store (= normal range で 保 持)", async () => {
  const stored = await runStoreAndRead(
    makeStoreValueGraph({ kind: "literal", type: "f32", value: 0.5 }),
  );
  expect(stored).toBe(0.5);
});

test("subnormal guard: literal store (= subnormal range で 0 flush)", async () => {
  const stored = await runStoreAndRead(
    makeStoreValueGraph({ kind: "literal", type: "f32", value: 1e-40 }),
  );
  expect(stored).toBe(0);
});

test("subnormal guard: 境 界 1e-30 ぴ っ た り は 保 持 (= strict `<` flush rule)", async () => {
  const stored = await runStoreAndRead(
    makeStoreValueGraph({ kind: "literal", type: "f32", value: 1e-30 }),
  );
  // 1e-30 は f32 で fround = 約 1.000000035e-30、 guard は abs < 1e-30 で 判 定 =
  // 境 界 値 は flush し な い (= 保 持)
  expect(stored).toBeCloseTo(Math.fround(1e-30), 35);
  expect(stored).not.toBe(0);
});

test("subnormal guard: 境 界 直 下 1e-31 は flush", async () => {
  const stored = await runStoreAndRead(
    makeStoreValueGraph({ kind: "literal", type: "f32", value: 1e-31 }),
  );
  expect(stored).toBe(0);
});

test("subnormal guard: 負 値 -1e-40 は abs で 判 定 し て flush", async () => {
  const stored = await runStoreAndRead(
    makeStoreValueGraph({ kind: "literal", type: "f32", value: -1e-40 }),
  );
  expect(stored).toBe(0);
});

test("subnormal guard: 負 normal -0.5 は 保 持", async () => {
  const stored = await runStoreAndRead(
    makeStoreValueGraph({ kind: "literal", type: "f32", value: -0.5 }),
  );
  expect(stored).toBe(-0.5);
});

test("subnormal guard: mul(literal, literal) 結 果 normal は 保 持", async () => {
  // 2 × 0.5 = 1.0
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

test("subnormal guard: mul(literal, literal) 結 果 subnormal は flush", async () => {
  // 1e-20 × 1e-15 = 1e-35 = subnormal range
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

test("subnormal guard: stateLoad source (= 別 state slot か ら load し た値 を そ の ま ま store)", async () => {
  // src に 0.7 を store → dst に src.load() を store (= guard 通 過、 0.7 保 持)
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

test("subnormal guard: self load × literal chain (= counter × 0.5 decay path)", async () => {
  // counter に 0.8 を store → counter × 0.5 を store → memory に 0.4 期 待
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

test("subnormal guard: audioInRead × literal、 forSample 外 (= per-block top-level)", async () => {
  // input[0] = 0.3、 store value = audioInRead × 2 = 0.6 期 待 (= guard 通 過)。
  // audio I/O 経 由 で memory load を 含 む value source の guard 通 過 path 担 保。
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

test("subnormal guard: audioInRead × literal、 forSample 内", async () => {
  // forSample 内 で input[i] × 2 を store = 各 sample で 上 書 き、 最 後 (= i=127) の
  // 値 が memory に残 る = input[127] × 2 = 0.3 × 2 = 0.6 期 待
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

test("subnormal guard: paramAt × literal、 forSample 内", async () => {
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

test("subnormal guard: deeply nested mul chain (= 3 段)", async () => {
  // (((0.4 × 0.5) × 0.5) × 0.5) = 0.05
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

test("subnormal guard: NaN store は guard 不発 で 保持 (= NaN < 1e-30 = false in IEEE 754)", async () => {
  const stored = await runStoreAndRead(
    makeStoreValueGraph({ kind: "literal", type: "f32", value: Number.NaN }),
  );
  expect(Number.isNaN(stored)).toBe(true);
});

test("subnormal guard: +Infinity store は 保 持", async () => {
  const stored = await runStoreAndRead(
    makeStoreValueGraph({ kind: "literal", type: "f32", value: Number.POSITIVE_INFINITY }),
  );
  expect(stored).toBe(Number.POSITIVE_INFINITY);
});

test("subnormal guard: -Infinity store は 保 持", async () => {
  const stored = await runStoreAndRead(
    makeStoreValueGraph({ kind: "literal", type: "f32", value: Number.NEGATIVE_INFINITY }),
  );
  expect(stored).toBe(Number.NEGATIVE_INFINITY);
});

test("subnormal guard: -0 store は abs(-0) = 0 < 1e-30 で flush → +0", async () => {
  const stored = await runStoreAndRead(
    makeStoreValueGraph({ kind: "literal", type: "f32", value: -0 }),
  );
  // -0 を store → guard で 0 に flush → memory の bit pattern = +0
  // Object.is で +0 / -0 区 別 可、 ただ 「flush 後 +0」 を 担 保 す る path
  expect(Object.is(stored, 0)).toBe(true);
});

test("subnormal guard: 同 block 内 で 同 state 2 度 store = 最 後 (= 0.7) が残 る", async () => {
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
  // 0.7 を f32 に fround = 0.699999988079071 = memory に そ の bit pattern で store
  expect(view[0]).toBe(Math.fround(0.7));
});

test("subnormal guard: defineProcessor 経 由 path repro (= offline test と 同 graph 構 築 経 路)", async () => {
  // import side-effect = `.mul` method form を Node prototype に 登 録
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
          out.ch(0).at(i).write(stored.load());
        });
        stored.store(input.ch(0).at(0).mul(2));
      },
    };
  });

  // captured graph を 取 り 出 し 直 接 emit + 走 ら せ る
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

test("subnormal guard: renderOffline と 同 形 ループ 再現 (= input fill → proc → output read を 2 度)", async () => {
  // renderOffline で NaN 出 る path を 詳細 再 現:
  // - forSample 内 で out[i] = z.load() を write
  // - forSample 外 で z = input[0] × 2 を store
  // - input fill 0.3 → proc → output check (block 0)
  // - input fill 0.7 → proc → output check (block 1) ← NaN trigger
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

  // block 0: input fill 0.3 → proc → output 確認
  const input0 = new Float32Array(memory.buffer, inputBase, 128);
  for (let s = 0; s < 128; s++) input0[s] = 0.3;
  proc();
  const output0 = new Float32Array(memory.buffer, outputBase, 128);
  // block 0: z 初期値 = 0 = output 全 0
  for (let s = 0; s < 128; s++) expect(output0[s]).toBe(0);

  // block 1: input fill 0.7 → proc → output 確認
  const input1 = new Float32Array(memory.buffer, inputBase, 128);
  for (let s = 0; s < 128; s++) input1[s] = 0.7;
  proc();
  const output1 = new Float32Array(memory.buffer, outputBase, 128);
  // block 1: z = block 0 末尾 で store した 0.6 = output 全 0.6
  for (let s = 0; s < 128; s++) expect(output1[s]).toBeCloseTo(0.6, 6);
});

test("subnormal guard: forSample 後 audioInRead × literal store、 2 度 process (= multi-block 駆 動 path)", async () => {
  // proc() を 2 度 呼 ぶ = multi-block 駆 動 = state slot が render quantum 跨 い で 持 続。
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
  // 1 度 目: z = 0.6 期 待
  const view1 = new Float32Array(memory.buffer, lay.regions.states.slots["z"]!, 1);
  expect(view1[0]).toBeCloseTo(0.6, 6);
  // 2 度 目: input = 0.3 のまま、 z = 0.6 期待 (= NaN な し)
  proc();
  const view2 = new Float32Array(memory.buffer, lay.regions.states.slots["z"]!, 1);
  expect(view2[0]).toBeCloseTo(0.6, 6);
});

test("subnormal guard: forSample 後 audioInRead × literal store (= offline integration 再 現)", async () => {
  // offline/index.test.ts で NaN 出 た fixture を emit unit test に 再 現:
  // forSample で audioOutput に stateLoad を write → forSample 外 で stateStore に
  // audioInRead × 2 を store。 input = 0.3 → z = 0.6 期 待。
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
// per-block publish scheduler = Phase 7 sub-phase 7.3
// (= publish flag 持 つ state slot を process 末 尾 で counter += 128 + threshold
// 越 え で copy + version increment + counter -= threshold で carry)
// ─────────────────────────────────────────────────────────────────────────

test("publish scheduler: publish ナ シ processor は emit に 影 響 ナ シ (= regression)", async () => {
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
  // publishShared / Counters region は empty = total bytes は state region 末 尾
  expect(wasm).toBeInstanceOf(Uint8Array);
  // basic regression: emit が 成 功 + state slot に 0.5 store さ れ る
  const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(wasmModule);
  const memory = instance.exports["memory"] as WebAssembly.Memory;
  const proc = instance.exports["process"] as () => void;
  proc();
  const view = new Float32Array(memory.buffer, lay.regions.states.slots["z"]!, 1);
  expect(view[0]).toBe(0.5);
});

test("publish scheduler: f32 1 slot で counter += 128 + threshold 越 え で due", async () => {
  // sampleRate 48000、 rateFps 30 → threshold = round(1600) = 1600
  // block 0..12 = not due (= counter = 128..1664)
  // block 13 で 1664 >= 1600 = due → copy + version 1 + counter = 64
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
  // sample counter = 13 × 128 = 1664、 ただ し block 13 で due 後 = 64
  expect(counterView[0]).toBe(64);
  expect(counterView[1]).toBe(1); // version = 1
  expect(sharedView[0]).toBe(Math.fround(0.7)); // copied
  // state side も 0.7 (= store)
  expect(stateView[0]).toBe(Math.fround(0.7));
});

test("publish scheduler: 2 block 連 続 で 2 度 due (= version 増 加)", async () => {
  // sampleRate 48000、 rateFps 30 → threshold 1600
  // 13 block 目 で 1 度 目 due (= counter 64)、 25 block 目 で 2 度 目 due
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

  // 25 block 走 ら せ る (= 1664 + 12 × 128 = 3200 = 2 × 1600)
  for (let b = 0; b < 25; b++) {
    proc();
  }
  // 13 block 目 = due 1 (= 64)
  // 14..24 block = counter 64 + 11 × 128 = 1472
  // 25 block 目 = counter 1472 + 128 = 1600 ≥ 1600 = due 2 → counter 0
  expect(counterView[0]).toBe(0);
  expect(counterView[1]).toBe(2); // version = 2
});

test("publish scheduler: i32 type で 値 copy", async () => {
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

  // 4 block 走 ら せ る = counter 512 ≥ 480 = due
  for (let b = 0; b < 4; b++) {
    proc();
  }
  expect(sharedView[0]).toBe(99);
});

test("publish scheduler: bool type で 値 copy (= 内 部 i32 表 現)", async () => {
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

  // 4 block = counter 512 ≥ 480 = due
  for (let b = 0; b < 4; b++) {
    proc();
  }
  expect(sharedView[0]).toBe(1);
});

test("publish scheduler: 2 publish slot は 独 立 counter / version", async () => {
  // 1 つ目 = rateFps 30 (threshold 1600)、 2 つ目 = rateFps 60 (threshold 800)
  // 13 block 走 ら せ る と:
  // - slot1 = 1664 → due 1、 counter 64、 version 1
  // - slot2 = 7 due (= 800 / 128 = 6.25、 7 block 目 で 896 ≥ 800、 13 block 目 で 1664 → 800 = 864 → 64)
  //   詳 細: block 7 で counter 896 ≥ 800 → due 1、 counter 96
  //         block 14 までは = 13 block 目 = counter 96 + 6 × 128 = 864 ≥ 800 → due 2、 counter 64
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
  // slow (rateFps 30、 threshold 1600): version 1、 counter 64
  expect(slowCounter[1]).toBe(1);
  expect(slowCounter[0]).toBe(64);
  // fast (rateFps 60、 threshold 800): block 7 で due 1、 block 13 で due 2 (= counter 96 + 6×128 = 864 → 64)
  expect(fastCounter[1]).toBe(2);
  expect(fastCounter[0]).toBe(64);
});

test("publish scheduler: threshold round 0 で 毎 block due", async () => {
  // sampleRate 100、 rateFps 1000 → threshold = round(0.1) = 0
  // counter 加 算 後 = 128 ≥ 0 = 毎 block due、 counter -= 0 = 128 残 す = 次 block も 毎 度 due
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

  // 5 block 走 ら せ る = 毎 度 due
  for (let b = 0; b < 5; b++) {
    proc();
  }
  // counter: 各 block で 128 ≥ 0 = due → counter -= 0 = 128 → 次 block も同 = 5 度 due、 counter 128
  // version = 5
  expect(counterView[1]).toBe(5);
});

test("publish scheduler: sampleRate option 反 映 (= threshold が sampleRate に 応 じ て 変 化)", async () => {
  // 同 processor で sampleRate 48000 vs 96000 = threshold 1600 vs 3200
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

  // sampleRate 48000 → threshold 1600 → 13 block で due
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

  // sampleRate 96000 → threshold 3200 → 25 block で due
  const wasm96 = await emit(graph, lay, { sampleRate: 96000 });
  const mod96 = await WebAssembly.compile(wasm96.buffer as ArrayBuffer);
  const inst96 = await WebAssembly.instantiate(mod96);
  const proc96 = inst96.exports["process"] as () => void;
  const counter96 = new Int32Array(
    (inst96.exports["memory"] as WebAssembly.Memory).buffer,
    lay.regions.publishCounters.slots["x"]!,
    2,
  );
  // 13 block では due ナ シ (= counter 1664 < 3200)
  for (let b = 0; b < 13; b++) proc96();
  expect(counter96[1]).toBe(0);
  // 25 block で due
  for (let b = 0; b < 12; b++) proc96();
  expect(counter96[1]).toBe(1);
});

test("subnormal guard f64: stateLoad source (= cross-precision な し path)", async () => {
  // f64 state ↔ state copy (= literal f64 を 経 由 し な い path、 既 NaN bug
  // と は 別 経 路 で 動 作 確 認)
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
// `event.emitIf` WASM emit (= sub-phase 7.6 commit 4)
//
// AST `eventEmitIf` を:
// - cond branch (= cond truthy で fire、 falsy で skip)
// - overflow check (= head + 1 - tail >= capacity で drop-oldest + overflowCount += 1)
// - slot fill (= base + 12 + (head % capacity) × slotSize に atSample + fields store)
// - head += 1
// の WASM IR に lower。 SAB Atomics は worklet template (= commit 5) で reflect、
// WASM 内 は 通 常 i32.load/store。
// ─────────────────────────────────────────────────────────────────────────

test("`emit(event emit 128 回)` = forSample 内 全 sample fire で slot 0..127 fill", async () => {
  // forSample 内 で emitIf(true, { atSample: i, level: 0.5 }) を 128 回 fire =
  // ringbuffer slot 0..127 を atSample = i / level = 0.5 で fill、 head = 128。
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
  // slot 0..127 = atSample + level = 8 byte × 128 = 1024 byte
  const slotsBase = ringBase + 12;
  const slotsAsI32 = new Int32Array(memory.buffer, slotsBase, 128 * 2);
  const slotsAsF32 = new Float32Array(memory.buffer, slotsBase, 128 * 2);
  for (let i = 0; i < 128; i++) {
    expect(slotsAsI32[i * 2]).toBe(i); // atSample
    expect(slotsAsF32[i * 2 + 1]).toBe(0.5); // level
  }
});

test("`emit(event emit cond=false)` = 全 sample skip で slot 不 変、 head = 0", async () => {
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
  expect(headView[0]).toBe(0); // head 不 変
  expect(headView[1]).toBe(0);
  expect(headView[2]).toBe(0);
});

test("`emit(event overflow)` = capacity 4 に 5 回 emit = head 5 / tail 1 / overflowCount 1", async () => {
  // capacity 4 の ring に 5 回 fire = 4 slot 埋 ま っ た 後 の 5 回 目 で drop-oldest 1 回 発 動。
  // forSample.stride を 256 / 128 = 2 に 設 定 し て iter 数 を 制 御 = ナ シ、 ま ず 「forSample
  // ナ シ で per-block top level 5 個 statement」 path で 5 回 fire 表 現。
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
  expect(headView[1]).toBe(1); // tail (= drop-oldest で 1 回 進 ん だ)
  expect(headView[2]).toBe(1); // overflowCount
  // slot 0 = 5 回 目 emit (= atSample = 4, level = 0.5) で 上 書 き
  const slot0AsI32 = new Int32Array(memory.buffer, ringBase + 12, 2);
  const slot0AsF32 = new Float32Array(memory.buffer, ringBase + 12, 2);
  expect(slot0AsI32[0]).toBe(4);
  expect(slot0AsF32[1]).toBe(0.5);
});

test("`emit(event 複 数 field 型)` = atSample (i32) + level (f32) + tick (i32) + flag (bool)", async () => {
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
  expect(slot0[3]).toBe(1); // flag (= u32 word 占 有)
});

test("`emit(event 複 数 declare)` = base 別 で 独 立 fire", async () => {
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

test("`emit(event f64 field)` = atSample (i32) + value (f64) で 8 byte store", async () => {
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
  // slot offset = ringBase + 12 (= header) + 0 (= atSample) / + 4 (= value f64)
  // f64 wire field は 4-byte align で 書 か れ る (= WASM mem.store align 制 約 ナ シ)、
  // JS 側 Float64Array は 8-byte align 必 須 ＝ DataView 経 由 で read。
  const view = new DataView(memory.buffer);
  expect(view.getInt32(ringBase + 12, true)).toBe(3); // atSample
  expect(view.getFloat64(ringBase + 12 + 4, true)).toBe(1.5); // value
});

test("`emit(event i64 field)` = atSample (i32) + stamp (i64) で 8 byte store", async () => {
  // i64 literal emit 未 サ ポ ー ト (= ast.ts literal `value: number` 制 約)、
  // stateLoad i64 経 由 で field 値 を 取 得 path で test。
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
  // tick state slot に 42n を 直 接 書 い て stateLoad が それ を 拾 う path
  const tickOffset = lay.regions.states.slots["tick"]!;
  new BigInt64Array(memory.buffer, tickOffset, 1)[0] = 42n;
  process();
  const ringBase = lay.regions.eventRings.slots["tickEvt"]!.base;
  // slot offset = ringBase + 12 (= header) + 0 (= atSample i32) / + 4 (= stamp i64)
  // i64 wire field は 4-byte align、 JS 側 BigInt64Array は 8-byte align 必 須 ＝
  // DataView 経 由 で read。
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
