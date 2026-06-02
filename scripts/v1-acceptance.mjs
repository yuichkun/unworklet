#!/usr/bin/env node
// v1.0.0 acceptance manifest — the single machine-checkable definition of "done".
//
// Why this exists: completion used to be claimed subjectively ("I did the docs"),
// which let work be skipped while tasks were marked complete. Here every
// deliverable is a GATE: a read-only command whose exit code decides pass/fail.
// A work item is done ONLY when its gate is green here. `node scripts/v1-acceptance.mjs`
// exiting 0 IS the definition of v1.0.0 release-ready, and is the surface a
// reviewer (or codex) audits — there is no subjective room left.
//
// Each gate runs a shell command; exit 0 = PASS. Add gates as work items land.
// Run: `node scripts/v1-acceptance.mjs` (all) or `--fast` (skip slow test/check gates).

import { execSync } from "node:child_process";

const FAST = process.argv.includes("--fast");

// Old-API patterns that must not appear as CURRENT spec in the docs/READMEs.
const OLD_API =
  "message<|node\\.messages|\\bmidiInput\\b|\\bmidiOutput\\b|messageDecl|[^.a-z]buffer\\.(f32|f64|i32|i64|bool|u8)|\\.load\\(|\\.store\\(";

// A gate: { id, desc, cmd, slow? }. cmd must exit non-zero on FAIL.
const gates = [
  {
    id: "WI-1 spec-docs-old-api",
    desc: "docs/00-11.md は現行 API のみ（旧 message/midiInput/buffer.X/.load/.store ゼロ）",
    cmd: `test "$(rg -c '${OLD_API}' docs/0*.md docs/1[01]*.md 2>/dev/null | awk -F: '{s+=$2} END{print s+0}')" = "0"`,
  },
  {
    id: "WI-2 history-docs-audit",
    desc: "decisions-log/RFC の旧 API 残存は supersede 注記済（監査 artifact 存在）",
    cmd: "test -f plans/artifacts/history-docs-audit.md",
  },
  {
    id: "WI-3 temporal-historical",
    desc: "docs に履歴的 temporal 表現ゼロ（originally/used to/legacy/retired/移動/廃止）",
    cmd: `test "$(rg -ci 'originally|used to|\\blegacy\\b|retired|移動|廃止' docs/*.md 2>/dev/null | awk -F: '{s+=$2} END{print s+0}')" = "0"`,
  },
  {
    id: "WI-4 doc-examples-test",
    desc: "README/llms/SKILL の全コード例を機械抽出して compile/render する test 緑",
    cmd: "vp test run packages/offline/src/docs-examples.test.ts",
    slow: true,
  },
  {
    id: "WI-5 agents-consumer-index",
    desc: "AGENTS.md に package README + llms.txt への consumer index",
    cmd: "rg -q 'packages/core/README' AGENTS.md && rg -q 'llms.txt' AGENTS.md",
  },
  {
    id: "WI-11 readme-sections",
    desc: "全 package README に install + usage(```ts) + API セクション",
    cmd:
      "for p in core lang offline test vite-plugin; do " +
      "rg -qi 'install' packages/$p/README.md && rg -q '```ts' packages/$p/README.md " +
      "&& rg -qi '## .*API|## Usage|## Reference' packages/$p/README.md || exit 1; done",
  },
  {
    id: "WI-11 readme-old-api",
    desc: "全 package README に旧 API ゼロ",
    cmd: `test "$(rg -c '${OLD_API}' packages/*/README.md 2>/dev/null | awk -F: '{s+=$2} END{print s+0}')" = "0"`,
  },
  {
    id: "WI-12 root-readme-logo",
    desc: "root README に unworklet ロゴ + package index、logo asset 存在",
    cmd:
      "rg -q 'unworklet-logo-chain' README.md && test -f assets/unworklet-logo-chain.svg " +
      "&& rg -qi 'quick start|getting started' README.md",
  },
  {
    id: "WI-6 browser-verify",
    desc: "全 panel の browser 実機目視 artifact（graph/state/signals/midi）",
    cmd:
      "test -f plans/artifacts/browser-verify-signals.json " +
      "&& test -f plans/artifacts/browser-verify-midi.json " +
      "&& test -f plans/artifacts/browser-verify-graph.json " +
      "&& test -f plans/artifacts/browser-verify-state.json",
  },
  {
    id: "WI-7 event-direction-narrowing",
    desc: "#40 event 方向の型 narrowing test 緑",
    cmd: "vp test run packages/core/src/event-direction.test-d.ts",
    slow: true,
  },
  {
    id: "WI-8 prev-slot-type",
    desc: "#47 $prev slot 型を戻り値から確定する test 緑",
    cmd: "vp test run packages/lang/src/__sugar__/prev-return-type.test.ts",
    slow: true,
  },
  {
    id: "WI-9 roadmap-status",
    desc: "10-roadmap の A1-F1 status 事実化 artifact",
    cmd: "test -f plans/artifacts/roadmap-status.md",
  },
  {
    id: "FINAL vp-check",
    desc: "workspace 全体 vp check 緑",
    cmd: "vp check",
    slow: true,
  },
];

let pass = 0;
let fail = 0;
const results = [];
for (const g of gates) {
  if (FAST && g.slow) {
    results.push(["SKIP", g.id, g.desc]);
    continue;
  }
  try {
    execSync(g.cmd, { stdio: "ignore", shell: "/bin/bash" });
    results.push(["PASS", g.id, g.desc]);
    pass++;
  } catch {
    results.push(["FAIL", g.id, g.desc]);
    fail++;
  }
}

const mark = (s) => (s === "PASS" ? "\x1b[32m✓\x1b[0m" : s === "FAIL" ? "\x1b[31m✗\x1b[0m" : "\x1b[2m–\x1b[0m");
for (const [status, id, desc] of results) {
  console.log(`${mark(status)} ${id.padEnd(32)} ${desc}`);
}
console.log(`\n${pass} pass / ${fail} fail${FAST ? " (fast: slow gates skipped)" : ""}`);
process.exit(fail === 0 ? 0 : 1);
