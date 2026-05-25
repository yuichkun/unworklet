/**
 * Static-analysis stage of the compile pipeline (= `03-compiler.md` §3、
 * plan Q-D stage 別 internal module の 1 つ目)。
 *
 * Phase 3 = noop (= 空 配 列 返 す だ け)。 layered error model の Layer 3
 * check 群 (= allocation / loop-boundedness / memory-budget / type
 * inference / constant-truthy emitIf 等) は 後 続 phase で kind ご と に
 * 段 階 的 に fill。 stable error ID は `03-compiler.md` §2.6 inventory。
 */

import type { CapturedGraph } from "./ast.ts";

export type DiagnosticEntry = {
  readonly id: string;
  readonly severity: "error" | "warning";
  readonly message: string;
};

export function analyze(_graph: CapturedGraph): DiagnosticEntry[] {
  return [];
}
