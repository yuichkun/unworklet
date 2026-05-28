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

export function analyze(graph: CapturedGraph): DiagnosticEntry[] {
  const diagnostics: DiagnosticEntry[] = [];
  for (const stmt of graph.statements) {
    if (stmt.kind === "forSample") {
      walkForConstantTruthyEmitIf(stmt.body, diagnostics);
    }
  }
  return diagnostics;
}
