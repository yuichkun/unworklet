/**
 * Schema-hash stage (= `01-dsl.md` §8.3 migration anchor). A deterministic,
 * structural fingerprint of the captured graph: the snapshot blob records the
 * hash it was minted under, and `restore` compares it to the current
 * processor's hash to decide whether the migration chain must run.
 *
 * Synchronous (= pure-JS FNV-1a, no Web Crypto) so the same value is available
 * at `defineProcessor` time (`CompiledProcessor.schemaHash`) and inside
 * `compile` (`CompileResult.schemaHash`) without an `await` — the two must
 * match for migration matching to work. Browser / Node / AudioWorkletGlobalScope
 * all run it identically.
 *
 * It hashes the whole graph (declarations + statements): any change that could
 * alter the compiled artifact yields a new hash, so a stale snapshot blob is
 * always detected. Changing this serialization is an intentional, snapshot-
 * breaking act — the inline snapshots in `schemaHash.test.ts` guard it.
 */

import type { CapturedGraph } from "./ast.ts";

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/** FNV-1a 64-bit over a byte stream, seeded by `offset`, returned as 16-hex. */
function fnv1a(bytes: Uint8Array, offset: bigint): string {
  let hash = offset;
  for (const b of bytes) {
    hash = ((hash ^ BigInt(b)) * FNV_PRIME) & MASK64;
  }
  return hash.toString(16).padStart(16, "0");
}

export function schemaHash(graph: CapturedGraph): string {
  // i64 literal value / state initial は bigint = JSON が serialize で きない。
  // `<value>n` 文 字 列 に 落 と し て deterministic + 値 別 に hash 反 映。
  const serialized = JSON.stringify(graph, (_key, value: unknown) =>
    typeof value === "bigint" ? `${value}n` : value,
  );
  const data = new TextEncoder().encode(serialized);
  // 2 つ の 異 な る seed lane を 連 結 し て 128-bit (= 32 hex)、 衝 突 余 裕 を 確 保。
  return fnv1a(data, FNV_OFFSET) + fnv1a(data, FNV_OFFSET ^ 0x9e3779b97f4a7c15n);
}
