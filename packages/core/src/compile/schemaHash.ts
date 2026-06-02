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
 * It hashes the **declarations** only — the slot schema a snapshot blob depends
 * on (names, kinds, types, sizes, snapshot policy). Process-body edits and
 * host-rate-specific coefficients do NOT change the hash, so a preset blob keeps
 * matching across logic tweaks and sample rates; only a genuine schema change
 * (slot rename / type widening / buffer resize, `01-dsl.md` §8.3) needs a
 * migration. Changing this serialization is an intentional, snapshot-breaking
 * act — the inline snapshots in `schemaHash.test.ts` guard it.
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
  // Declarations only (= the slot schema). i64 literal values / state initials
  // are bigint, which JSON cannot serialize, so they are rendered as the string
  // `<value>n` to stay deterministic and reflect each distinct value in the hash.
  const serialized = JSON.stringify(graph.declarations, (_key, value: unknown) =>
    typeof value === "bigint" ? `${value}n` : value,
  );
  const data = new TextEncoder().encode(serialized);
  // Concatenate two lanes with distinct seeds to form 128 bits (= 32 hex), leaving ample collision headroom.
  return fnv1a(data, FNV_OFFSET) + fnv1a(data, FNV_OFFSET ^ 0x9e3779b97f4a7c15n);
}
