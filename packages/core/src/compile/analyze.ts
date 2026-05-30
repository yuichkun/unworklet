/**
 * Static-analysis stage of the compile pipeline (= `03-compiler.md` §3、
 * plan Q-D stage 別 internal module の 1 つ目)。
 *
 * Layer 3 check 群 を kind ご と に 順 次 fill。 現 状 fill 済:
 *   - `constant-truthy-emitif` (Q32-c): `forSample` callback 内 で 構 文 上
 *     constant-truthy な `emitIf` cond は emit 前 に reject。
 *   - `select-branch-type-mismatch`: `select` の 2 branch が 異 な る scalar 型 =
 *     WASM `select` は 同 型 branch 必 須 = reject。 多 型 lowering 後 も branch 型
 *     不 一 致 (= TS をすり抜けた 場 合) を fail-loud で 弾 く。
 *
 * 算 術 / 比 較 は operand の scalar 型 を AST に 担 ぎ、 emit が 型 別 命 令 を
 * 出 す (= 多 型 lowering)。 旧 `non-f32-arithmetic` guard (= f32 固 定 emit 時 代 の
 * silent mis-compile 防 止) は 撤 去 済 み。
 */

import type { AstNode, CapturedGraph } from "./ast.ts";
import { inferAstType } from "./ast.ts";

export type DiagnosticEntry = {
  readonly id: string;
  readonly severity: "error" | "warning";
  readonly message: string;
};

/**
 * cond AST が build-time-constant な truthy 値 を 表 す か。 graph capture 時
 * の literal lift と zip し て、 literal で value !== 0 = truthy と 判 定。
 */
function isConstantTruthy(node: AstNode): boolean {
  return node.kind === "literal" && node.value !== 0;
}

function walkForConstantTruthyEmitIf(
  body: readonly AstNode[],
  diagnostics: DiagnosticEntry[],
): void {
  for (const node of body) {
    if (node.kind === "eventEmitIf" && isConstantTruthy(node.cond)) {
      diagnostics.push({
        id: "constant-truthy-emitif",
        severity: "error",
        message: `unworklet: event "${node.name}" emitIf has a constant-truthy cond inside forSample — unconditional emission at audio rate fills the ringbuffer in milliseconds. Use a state-edge gated cond, move the emission to a handler context, or wrap it in everyNSamples(N, ...) for sub-rate periodic emission (= Q32-c, stable ID 'constant-truthy-emitif')`,
      });
    }
    if (node.kind === "forSample") {
      walkForConstantTruthyEmitIf(node.body, diagnostics);
    }
  }
}

/**
 * 全 node を walk し、 `select` の branch 型 不 一 致 を 検 出 (= `select-branch-type-mismatch`)。
 * literal branch は select builder が branch 型 へ lift 済 み (= Q33)、 ここ で 弾 く の は
 * TS を す り 抜 け た 真 の 型 不 一 致 (= `Node<'f32'>` と `Node<'i32'>` の 2 branch 等)。
 */
function walkForTypeErrors(node: AstNode, diagnostics: DiagnosticEntry[]): void {
  switch (node.kind) {
    case "mul":
    case "add":
    case "sub":
    case "div":
    case "mod":
    case "max":
    case "min":
    case "eq":
    case "lt":
    case "gt":
    case "lte":
    case "gte":
      walkForTypeErrors(node.lhs, diagnostics);
      walkForTypeErrors(node.rhs, diagnostics);
      break;
    case "abs":
    case "neg":
    case "sqrt":
    case "floor":
    case "ceil":
    case "frac":
    case "sin":
    case "cos":
    case "tan":
    case "exp":
    case "log":
    case "tanh":
    case "convert":
      walkForTypeErrors(node.value, diagnostics);
      break;
    case "clamp":
      walkForTypeErrors(node.x, diagnostics);
      walkForTypeErrors(node.lo, diagnostics);
      walkForTypeErrors(node.hi, diagnostics);
      break;
    case "select": {
      const thenType = inferAstType(node.ifTrue);
      const elseType = inferAstType(node.ifFalse);
      if (thenType !== elseType) {
        diagnostics.push({
          id: "select-branch-type-mismatch",
          severity: "error",
          message: `unworklet: select branches have mismatched scalar types ('${thenType}' vs '${elseType}') — WASM select requires both branches to be the same type. (stable ID 'select-branch-type-mismatch')`,
        });
      }
      walkForTypeErrors(node.cond, diagnostics);
      walkForTypeErrors(node.ifTrue, diagnostics);
      walkForTypeErrors(node.ifFalse, diagnostics);
      break;
    }
    case "audioInRead":
    case "paramAt":
      walkForTypeErrors(node.offset, diagnostics);
      break;
    case "audioOutWrite":
      walkForTypeErrors(node.offset, diagnostics);
      walkForTypeErrors(node.value, diagnostics);
      break;
    case "stateStore":
      walkForTypeErrors(node.value, diagnostics);
      break;
    case "bufferRead":
      walkForTypeErrors(node.index, diagnostics);
      break;
    case "bufferReadInterpolated":
      walkForTypeErrors(node.pos, diagnostics);
      break;
    case "payloadFieldRead":
      walkForTypeErrors(node.index, diagnostics);
      break;
    case "payloadFieldLength":
      break;
    case "bufferCopyFrom":
      // 子 expression ナ シ (= bufferName / messageName / field は string)。
      break;
    case "bufferWrite":
      walkForTypeErrors(node.index, diagnostics);
      walkForTypeErrors(node.value, diagnostics);
      break;
    case "forSample":
    case "messageOnReceive":
    case "everyNSamples":
      for (const child of node.body) walkForTypeErrors(child, diagnostics);
      break;
    case "eventEmitIf":
      walkForTypeErrors(node.cond, diagnostics);
      walkForTypeErrors(node.atSample, diagnostics);
      for (const field of node.fields) {
        walkForTypeErrors(field.value, diagnostics);
        if (field.length !== undefined) walkForTypeErrors(field.length, diagnostics);
      }
      break;
    case "literal":
    case "loopCounter":
    case "stateLoad":
    case "messageFieldRead":
      break;
  }
}

// forSample.byN(stride) で許可する stride = 1 ブロック (128) を割り切る 2 の冪。
// SIMD bulk (stride 4 で 4 sample load) 等で 128 / stride が整数になる必要がある。
const ALLOWED_STRIDES = new Set([1, 2, 4, 8, 16, 32, 64, 128]);

function walkForIllegalStride(body: readonly AstNode[], diagnostics: DiagnosticEntry[]): void {
  for (const node of body) {
    if (node.kind === "forSample") {
      if (!ALLOWED_STRIDES.has(node.stride)) {
        diagnostics.push({
          id: "illegal-stride",
          severity: "error",
          message: `unworklet: forSample.byN stride ${node.stride} は render quantum (128) を割り切る 2 の冪ではない。許可: 1, 2, 4, 8, 16, 32, 64, 128 (stable ID 'illegal-stride')`,
        });
      }
      walkForIllegalStride(node.body, diagnostics);
    }
  }
}

export function analyze(graph: CapturedGraph): DiagnosticEntry[] {
  const diagnostics: DiagnosticEntry[] = [];
  walkForIllegalStride(graph.statements, diagnostics);
  for (const stmt of graph.statements) {
    if (stmt.kind === "forSample") {
      walkForConstantTruthyEmitIf(stmt.body, diagnostics);
    }
    walkForTypeErrors(stmt, diagnostics);
  }
  return diagnostics;
}
