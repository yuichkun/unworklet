/**
 * `worklet-entry.ts` から static import で到達する core 内ファイル一覧（= worklet
 * バンドルに同梱され、AudioWorkletGlobalScope で評価されるソース集合）。
 *
 * 単一ソースとして 2 箇所が参照する:
 *   - root `vite.config.ts` の `lint.overrides` … この集合にだけ `no-restricted-globals`
 *     を効かせ、AudioWorkletGlobalScope に無い main-thread / Node web API
 *     (`TextEncoder` / `fetch` / `setTimeout` / `document` 等) の使用を CI で落とす。
 *   - `worklet-realm-files.test.ts` … `worklet-entry.ts` から実際の import graph を
 *     辿り、この一覧と一致することを検証する。新しいファイルが worklet バンドルに
 *     入ったのに lint 対象から漏れる事故を防ぐ（= glob と graph のズレ検出）。
 *
 * パスは packages/core からの相対。順序は意味を持たない（集合として比較する）。
 */
export const WORKLET_REALM_FILES = [
  "src/worklet-entry.ts",
  "src/worklet.ts",
  "src/snapshot.ts",
  "src/types.ts",
  "src/compile/ast.ts",
  "src/compile/layout.ts",
  "src/dsl/constants.ts",
] as const;
