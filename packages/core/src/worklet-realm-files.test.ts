/**
 * worklet realm 安全ガードの「適用範囲」を守るテスト。
 *
 * `vite.config.ts` の `lint.overrides` は `WORKLET_REALM_FILES` にだけ
 * `no-restricted-globals`（AudioWorkletGlobalScope に無い main-thread API の禁止）を
 * 効かせる。その glob が「実際に worklet バンドルへ入るファイル集合」とズレると、
 * 新しく worklet グラフへ入ったファイルが禁止 API チェックの網から漏れる
 * （= denylist / glob 方式の唯一の弱点）。
 *
 * このテストは `worklet-entry.ts` から static import / export を辿って実際のグラフを
 * 計算し、`WORKLET_REALM_FILES` と完全一致することを検証する。ズレたら fail。
 * → lint の対象集合が常に worklet グラフ＝バンドル内容と一致することを構造的に保証する。
 */

import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";

import { WORKLET_REALM_FILES } from "./worklet-realm-files.ts";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = dirname(SRC_DIR);

/**
 * `entryRel`（packages/core 相対）から static な `from "./…"` / `import "./…"`
 * を辿って到達する core 内ファイルを packages/core 相対パスの集合で返す。
 * 型のみ import（`import type … from "./…"`）も含む = lint 対象としては超集合で
 * 構わない（型ファイルに禁止 global の値参照は無いので無害、かつ保守的）。
 */
function traceWorkletGraph(entryRel: string): Set<string> {
  const seen = new Set<string>();
  const importRe = /(?:from|import)\s+"(\.[^"]+)"/g;
  const visit = (absPath: string): void => {
    const rel = relative(PKG_DIR, absPath);
    if (seen.has(rel)) return;
    seen.add(rel);
    let src: string;
    try {
      src = readFileSync(absPath, "utf8");
    } catch {
      return;
    }
    const dir = dirname(absPath);
    for (const m of src.matchAll(importRe)) {
      visit(resolve(dir, m[1]!));
    }
  };
  visit(resolve(PKG_DIR, entryRel));
  return seen;
}

test("worklet realm の import graph が WORKLET_REALM_FILES と一致する（lint ガードの適用漏れ防止）", () => {
  const graph = traceWorkletGraph("src/worklet-entry.ts");
  const declared = new Set<string>(WORKLET_REALM_FILES);

  const missing = [...graph].filter((f) => !declared.has(f)).sort();
  const stale = [...declared].filter((f) => !graph.has(f)).sort();

  expect(
    missing,
    "worklet-entry.ts から到達する（= worklet バンドルに入る）のに WORKLET_REALM_FILES に無い。" +
      "no-restricted-globals の網から漏れている。worklet-realm-files.ts に追加するか、該当 import を worklet 非依存にすること。",
  ).toEqual([]);
  expect(
    stale,
    "WORKLET_REALM_FILES にあるが worklet-entry.ts から到達しない。worklet-realm-files.ts から削除すること。",
  ).toEqual([]);
});
