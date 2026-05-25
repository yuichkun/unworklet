/**
 * Schema-hash stage of the compile pipeline (= `01-dsl.md` §8.3 migration
 * anchor、 plan Q-D stage 別 internal module の 1 つ)。
 *
 * Phase 3 で hash 形 を fix = `JSON.stringify(graph)` + SHA-256 hex。
 * declaration / statement の 順 序 + 内 容 が hash に 反 映 = deterministic
 * + structural。 各 fixture の hex は schemaHash.test.ts の inline
 * snapshot で 固 定 = 後 続 phase で 形 を 変 え た 瞬 間 fail で 検 知。
 *
 * 後 続 phase で 形 を 変 え る 必 要 が 出 た 場 合 = 意 図 的 inline
 * snapshot 更 新 + 既 snapshot blob 互 換 を 別 path (= migration helper、
 * `01-dsl.md` §8.3.1) で 処 理 す る = 「絶 対 変 わ ら な い」 invariant を
 * 明 示 的 retract す る 形 で 拡 張。
 */

import { createHash } from "node:crypto";

import type { CapturedGraph } from "./ast.ts";

export function schemaHash(graph: CapturedGraph): string {
  const serialized = JSON.stringify(graph);
  return createHash("sha256").update(serialized).digest("hex");
}
