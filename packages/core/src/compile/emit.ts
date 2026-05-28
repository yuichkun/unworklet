/**
 * WASM emission stage of the compile pipeline (= plan Q-F 引 数 ナ シ +
 * 固 定 region WASM export、 plan Q-D stage 別 internal module の 1 つ)。
 *
 * binaryen を dynamic import (= `09-repo-structure.md` §2.4 invariant、
 * static path consumer の production runtime bundle に は 含 ま な い) し て
 * AST → binaryen IR lower。 出 力 = WASM binary (= Uint8Array)。
 *
 * WASM の linear memory は `layout.totalBytes` を 64 KB page で 切 り 上 げ た
 * size を min == max で pre-allocate (= `memory.grow` 永 久 排 除、
 * `00-foundations.md` §5.1 invariant)。 export = `process` (= 引 数 ナ シ、
 * Q-F) + `memory` (= host が 固 定 offset で 入 出 力 marshal)。
 *
 * forSample = bounded loop (= Phase 1 step-1.7 path 移 植) で stride 単 位 に
 * 増 加、 loopCounter は local 0 を 経 由。 Phase 3 = forSample 1 階 層 想 定
 * (= canonical Ex 1 minus meter)、 nested forSample / forSample.byN 対 応 は
 * 後 続 phase で fill。
 */

import type { AstNode, CapturedGraph } from "./ast.ts";
import type { Layout } from "./layout.ts";

export type BinaryenAPI = (typeof import("binaryen"))["default"];
export type BinaryenModule = InstanceType<BinaryenAPI["Module"]>;

const BYTES_PER_F32 = 4;
const BYTES_PER_F64 = 8;
const BYTES_PER_I32 = 4;
const BYTES_PER_I64 = 8;
const CHANNEL_STRIDE_BYTES = 128 * BYTES_PER_F32;
const PAGE_BYTES = 65536;
const LOOP_COUNTER_LOCAL = 0;

/**
 * Subnormal flush threshold (= Q21、 `04-worklet-runtime.md` §6)。
 * `state.f32` / `state.f64` の `.store(v)` で `|v| < 1e-30` を 0 に 落 と し て
 * IIR feedback path で の CPU spike を 撤 廃。 threshold 1e-30 は
 * IEEE 754 binary32 subnormal 範 囲 (≈ 1.18e-38 以 下) を 含 む 単 純
 * boundary、 normal 範 囲 末 端 も 同 時 flush だ が audio 出 力 と し て
 * 不 可 聴 = 1 値 fix。
 */
const SUBNORMAL_THRESHOLD = 1e-30;

export async function emit(graph: CapturedGraph, layout: Layout): Promise<Uint8Array> {
  const binaryen = (await import("binaryen")).default;
  const mod = new binaryen.Module();

  const pages = Math.max(1, Math.ceil(layout.totalBytes / PAGE_BYTES));
  mod.setMemory(pages, pages, "memory");

  const statements = graph.statements.map((s) => emitStatement(s, layout, mod, binaryen));
  const body = mod.block(null, statements);

  mod.addFunction("process", binaryen.none, binaryen.none, [binaryen.i32], body);
  mod.addFunctionExport("process", "process");

  const wasm = mod.emitBinary();
  mod.dispose();
  return wasm;
}

export function emitExpression(
  node: AstNode,
  layout: Layout,
  mod: BinaryenModule,
  binaryen: BinaryenAPI,
): number {
  switch (node.kind) {
    case "literal":
      // sub-phase 7.1 で f64 literal 対 応 を 追 加 (= state.f64 subnormal guard
      // test で 1e-40 等 の 値 を 直 接 渡 す path)。 i64 / bool literal は
      // ast.ts の literal `value: number` 制 約 下 で 表 現 不 完 全 (= i64 は
      // BigInt 必 要 + bool は boolean が 自 然) = 後 続 sub-phase で literal
      // 型 拡 張 と zip し て fill。 当 phase で は state.i64 / state.bool は
      // 別 path (= stateLoad / 既 memory 値) で 駆 動 す る。
      switch (node.type) {
        case "f32":
          return mod.f32.const(node.value);
        case "f64":
          return mod.f64.const(node.value);
        case "i32":
          return mod.i32.const(node.value);
        case "i64":
          throw new Error("i64 literal emission not implemented (= 後 続 sub-phase で fill)");
        case "bool":
          throw new Error("bool literal emission not implemented (= 後 続 sub-phase で fill)");
      }
    case "loopCounter":
      return mod.local.get(LOOP_COUNTER_LOCAL, binaryen.i32);
    case "mul":
      return mod.f32.mul(
        emitExpression(node.lhs, layout, mod, binaryen),
        emitExpression(node.rhs, layout, mod, binaryen),
      );
    case "audioInRead": {
      const portBase = layout.regions.ioScratch.inputs[node.portName];
      if (portBase === undefined) {
        throw new Error(`unknown audioInput port: ${node.portName}`);
      }
      const channelBase = portBase + node.channel * CHANNEL_STRIDE_BYTES;
      const ptr = mod.i32.add(
        mod.i32.const(channelBase),
        mod.i32.mul(
          emitExpression(node.offset, layout, mod, binaryen),
          mod.i32.const(BYTES_PER_F32),
        ),
      );
      return mod.f32.load(0, BYTES_PER_F32, ptr);
    }
    case "paramAt": {
      const paramBase = layout.regions.ioScratch.params[node.paramName];
      if (paramBase === undefined) {
        throw new Error(`unknown param: ${node.paramName}`);
      }
      const ptr = mod.i32.add(
        mod.i32.const(paramBase),
        mod.i32.mul(
          emitExpression(node.offset, layout, mod, binaryen),
          mod.i32.const(BYTES_PER_F32),
        ),
      );
      return mod.f32.load(0, BYTES_PER_F32, ptr);
    }
    case "stateLoad": {
      const slotOffset = layout.regions.states.slots[node.name];
      if (slotOffset === undefined) {
        throw new Error(`unknown state slot: ${node.name}`);
      }
      const ptr = mod.i32.const(slotOffset);
      switch (node.type) {
        case "f32":
          return mod.f32.load(0, BYTES_PER_F32, ptr);
        case "f64":
          return mod.f64.load(0, BYTES_PER_F64, ptr);
        case "i32":
          return mod.i32.load(0, BYTES_PER_I32, ptr);
        case "i64":
          return mod.i64.load(0, BYTES_PER_I64, ptr);
        case "bool":
          // bool は 内 部 i32 表 現 (= 0 / 1)、 caller 側 で `select` / `lt` 等 で
          // 利 用 す る (= Q42 + sub-phase 7.4 SAB publish path と zip)
          return mod.i32.load(0, BYTES_PER_I32, ptr);
      }
    }
    case "audioOutWrite":
    case "forSample":
    case "stateStore":
      throw new Error(`statement node '${node.kind}' cannot appear in expression position`);
  }
}

export function emitStatement(
  node: AstNode,
  layout: Layout,
  mod: BinaryenModule,
  binaryen: BinaryenAPI,
): number {
  switch (node.kind) {
    case "stateStore": {
      const slotOffset = layout.regions.states.slots[node.name];
      if (slotOffset === undefined) {
        throw new Error(`unknown state slot: ${node.name}`);
      }
      const ptr = mod.i32.const(slotOffset);
      switch (node.type) {
        case "f32":
          return mod.f32.store(
            0,
            BYTES_PER_F32,
            ptr,
            emitSubnormalGuardF32(node.value, layout, mod, binaryen),
          );
        case "f64":
          return mod.f64.store(
            0,
            BYTES_PER_F64,
            ptr,
            emitSubnormalGuardF64(node.value, layout, mod, binaryen),
          );
        case "i32":
          return mod.i32.store(
            0,
            BYTES_PER_I32,
            ptr,
            emitExpression(node.value, layout, mod, binaryen),
          );
        case "i64":
          return mod.i64.store(
            0,
            BYTES_PER_I64,
            ptr,
            emitExpression(node.value, layout, mod, binaryen),
          );
        case "bool":
          // bool は 内 部 i32 表 現 (= store も i32.store、 subnormal guard ナ シ)
          return mod.i32.store(
            0,
            BYTES_PER_I32,
            ptr,
            emitExpression(node.value, layout, mod, binaryen),
          );
      }
    }
    case "audioOutWrite": {
      const portBase = layout.regions.ioScratch.outputs[node.portName];
      if (portBase === undefined) {
        throw new Error(`unknown audioOutput port: ${node.portName}`);
      }
      const channelBase = portBase + node.channel * CHANNEL_STRIDE_BYTES;
      const ptr = mod.i32.add(
        mod.i32.const(channelBase),
        mod.i32.mul(
          emitExpression(node.offset, layout, mod, binaryen),
          mod.i32.const(BYTES_PER_F32),
        ),
      );
      return mod.f32.store(
        0,
        BYTES_PER_F32,
        ptr,
        emitExpression(node.value, layout, mod, binaryen),
      );
    }
    case "forSample": {
      const loopBody = node.body.map((s) => emitStatement(s, layout, mod, binaryen));
      return mod.block(null, [
        mod.local.set(LOOP_COUNTER_LOCAL, mod.i32.const(0)),
        mod.block("break", [
          mod.loop(
            "continue",
            mod.block(null, [
              mod.br_if(
                "break",
                mod.i32.ge_s(mod.local.get(LOOP_COUNTER_LOCAL, binaryen.i32), mod.i32.const(128)),
              ),
              ...loopBody,
              mod.local.set(
                LOOP_COUNTER_LOCAL,
                mod.i32.add(
                  mod.local.get(LOOP_COUNTER_LOCAL, binaryen.i32),
                  mod.i32.const(node.stride),
                ),
              ),
              mod.br("continue"),
            ]),
          ),
        ]),
      ]);
    }
    default:
      throw new Error(`expression node '${node.kind}' cannot appear in statement position`);
  }
}

/**
 * Subnormal guard emit (= `|v| < 1e-30 ? 0 : v` の WASM IR、 Q21)。
 * f32 / f64 の `state.store(v)` で 自 動 inline。 重 複 evaluation で
 * sub-expression を 2 回 emit (= side-effect ナ シ expression 限 定 = 安 全、
 * binaryen optimizer が CSE で 1 回 に collapse す る path)。
 */
function emitSubnormalGuardF32(
  valueNode: AstNode,
  layout: Layout,
  mod: BinaryenModule,
  binaryen: BinaryenAPI,
): number {
  const v1 = emitExpression(valueNode, layout, mod, binaryen);
  const v2 = emitExpression(valueNode, layout, mod, binaryen);
  return mod.select(
    mod.f32.lt(mod.f32.abs(v1), mod.f32.const(SUBNORMAL_THRESHOLD)),
    mod.f32.const(0),
    v2,
  );
}

function emitSubnormalGuardF64(
  valueNode: AstNode,
  layout: Layout,
  mod: BinaryenModule,
  binaryen: BinaryenAPI,
): number {
  const v1 = emitExpression(valueNode, layout, mod, binaryen);
  const v2 = emitExpression(valueNode, layout, mod, binaryen);
  return mod.select(
    mod.f64.lt(mod.f64.abs(v1), mod.f64.const(SUBNORMAL_THRESHOLD)),
    mod.f64.const(0),
    v2,
  );
}
