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
const CHANNEL_STRIDE_BYTES = 128 * BYTES_PER_F32;
const PAGE_BYTES = 65536;
const LOOP_COUNTER_LOCAL = 0;

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
      return node.type === "f32" ? mod.f32.const(node.value) : mod.i32.const(node.value);
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
    case "audioOutWrite":
    case "forSample":
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
