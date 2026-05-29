/**
 * Static-analysis stage of the compile pipeline (= `03-compiler.md` §3、
 * plan Q-D stage 別 internal module の 1 つ目)。
 *
 * Layer 3 check 群 を kind ご と に 順 次 fill。 現 状 fill 済:
 *   - `constant-truthy-emitif` (Q32-c): `forSample` callback 内 で 構 文 上
 *     constant-truthy な `emitIf` cond は emit 前 に reject。 unconditional
 *     emission at audio rate は 256-slot ringbuffer を ミ リ 秒 で 埋 め て
 *     continuous overflow に なる footgun を 構 造 上 排 除 (= `01-dsl.md`
 *     §4.1 + `decisions-log.md` Q32-c)。
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
 * の literal lift (= `boolean true` → `{ kind: 'literal', type: 'i32', value: 1 }`)
 * と zip し て、 literal で value !== 0 = truthy と 判 定。 stateLoad / mul /
 * audioInRead 等 = dynamic = false 返 却。
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
      // nested forSample = audio thread の inner loop = 同 ル ー ル 適 用 (= 構 造
      // 上 ま ず 出 な い が defensive で walk)。
      walkForConstantTruthyEmitIf(node.body, diagnostics);
    }
  }
}

/**
 * 算 術 / 比 較 / math primitive (= add / sub / mul / div / mod / neg / min /
 * max / abs / sqrt / floor / ceil / frac / sin / cos / tan / tanh / exp / log /
 * clamp / 比 較) は **f32 path の み** emit す る (= 各 op が `f32.*` 命 令 を
 * hardcode、 `01-dsl.md` §2.1 の generic-T surface は 多 型 lowering = 後 続
 * フ ェ ー ズ)。 非 f32 オ ペ ラ ン ド (= state.i32 / loopCounter 等) を 渡 す と
 * `f32.add` 等 に i32 値 が 流 れ 込 ん で invalid WASM module に な る の で、 emit
 * 前 に 明 確 な 診 断 エ ラ ー で 弾 く (= silent mis-compile を fail-loud 化)。
 * 多 型 lowering 実 装 時 に こ の ガ ー ド は 撤 去 す る。
 */
function requireF32Operand(operand: AstNode, opKind: string, diagnostics: DiagnosticEntry[]): void {
  const t = inferAstType(operand);
  if (t !== "f32") {
    diagnostics.push({
      id: "non-f32-arithmetic",
      severity: "error",
      message: `unworklet: '${opKind}' received a '${t}' operand, but arithmetic / comparison / math primitives currently lower as f32 only — i32 / i64 / f64 multi-type lowering is a later phase. (stable ID 'non-f32-arithmetic')`,
    });
  }
}

/** 全 node を walk し、 算 術 系 node の オ ペ ラ ン ド が 非 f32 な ら 診 断。 */
function walkForNonF32Arithmetic(node: AstNode, diagnostics: DiagnosticEntry[]): void {
  switch (node.kind) {
    case "add":
    case "sub":
    case "mul":
    case "div":
    case "mod":
    case "max":
    case "min":
    case "eq":
    case "lt":
    case "gt":
    case "lte":
    case "gte":
      requireF32Operand(node.lhs, node.kind, diagnostics);
      requireF32Operand(node.rhs, node.kind, diagnostics);
      walkForNonF32Arithmetic(node.lhs, diagnostics);
      walkForNonF32Arithmetic(node.rhs, diagnostics);
      break;
    case "neg":
    case "abs":
    case "sqrt":
    case "floor":
    case "ceil":
    case "frac":
    case "sin":
    case "cos":
    case "tan":
    case "tanh":
    case "exp":
    case "log":
      requireF32Operand(node.value, node.kind, diagnostics);
      walkForNonF32Arithmetic(node.value, diagnostics);
      break;
    case "clamp":
      requireF32Operand(node.x, node.kind, diagnostics);
      requireF32Operand(node.lo, node.kind, diagnostics);
      requireF32Operand(node.hi, node.kind, diagnostics);
      walkForNonF32Arithmetic(node.x, diagnostics);
      walkForNonF32Arithmetic(node.lo, diagnostics);
      walkForNonF32Arithmetic(node.hi, diagnostics);
      break;
    // select は binaryen `select` が型非依存 = operand 型 hardcode な し = チェック不要。
    case "select":
      walkForNonF32Arithmetic(node.cond, diagnostics);
      walkForNonF32Arithmetic(node.ifTrue, diagnostics);
      walkForNonF32Arithmetic(node.ifFalse, diagnostics);
      break;
    case "audioInRead":
    case "paramAt":
      walkForNonF32Arithmetic(node.offset, diagnostics);
      break;
    case "audioOutWrite":
      walkForNonF32Arithmetic(node.offset, diagnostics);
      walkForNonF32Arithmetic(node.value, diagnostics);
      break;
    case "stateStore":
      walkForNonF32Arithmetic(node.value, diagnostics);
      break;
    case "forSample":
    case "messageOnReceive":
      for (const child of node.body) walkForNonF32Arithmetic(child, diagnostics);
      break;
    case "eventEmitIf":
      walkForNonF32Arithmetic(node.cond, diagnostics);
      walkForNonF32Arithmetic(node.atSample, diagnostics);
      for (const field of node.fields) walkForNonF32Arithmetic(field.value, diagnostics);
      break;
    case "literal":
    case "loopCounter":
    case "stateLoad":
    case "messageFieldRead":
      break;
  }
}

export function analyze(graph: CapturedGraph): DiagnosticEntry[] {
  const diagnostics: DiagnosticEntry[] = [];
  for (const stmt of graph.statements) {
    if (stmt.kind === "forSample") {
      walkForConstantTruthyEmitIf(stmt.body, diagnostics);
    }
    walkForNonF32Arithmetic(stmt, diagnostics);
  }
  return diagnostics;
}
