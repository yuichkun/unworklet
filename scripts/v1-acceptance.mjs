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
// PCRE2 (rg -P): `(?<!Atomics)\.(load|store)\(` excludes the Web-Platform
// `Atomics.load/store` from the old DSL `state.<x>.load/store`, and
// `(?<![.a-z])buffer\.` excludes the current `state.buffer.<type>`.
const OLD_API =
  "message<|node\\.messages|\\bmidiInput\\b|\\bmidiOutput\\b|messageDecl|(?<![.a-z])buffer\\.(f32|f64|i32|i64|bool|u8)|(?<!Atomics)\\.load\\(|(?<!Atomics)\\.store\\(";
// Spec docs = everything under docs/ EXCEPT the historical record (decisions-log
// + RFCs), which keep their as-decided wording with supersede notes (WI-2).
// Use a directory arg (not a shell glob of explicit paths) so rg's -g filters
// actually apply — `-g` is ignored for explicitly-listed file arguments.
const SPEC_DOCS = "docs/ -g '*.md' -g '!decisions-log.md' -g '!rfc-*.md' -g '!RFC-*.md'";

// A gate: { id, desc, cmd, slow? }. cmd must exit non-zero on FAIL.
const gates = [
  {
    id: "WI-1 spec-docs-old-api",
    desc: "Spec docs (all docs except the historical record) use only the current API — zero old message/midiInput/buffer.X/.load/.store",
    cmd: `test "$(rg -cP '${OLD_API}' ${SPEC_DOCS} 2>/dev/null | awk -F: '{s+=$2} END{print s+0}')" = "0"`,
  },
  {
    id: "WI-2 history-docs-audit",
    desc: "Old API still present in decisions-log/RFCs is annotated as superseded (audit artifact exists)",
    cmd: "test -f plans/artifacts/history-docs-audit.md",
  },
  {
    id: "WI-3 temporal-historical",
    desc: "Spec docs contain zero historical/temporal phrasing (originally/used to/legacy/retired)",
    cmd: `test "$(rg -ci 'originally|used to|\\blegacy\\b|retired' ${SPEC_DOCS} 2>/dev/null | awk -F: '{s+=$2} END{print s+0}')" = "0"`,
  },
  {
    id: "WI-4 doc-examples-test",
    desc: "Test that machine-extracts every code example from README/llms/SKILL and compiles/renders it is green",
    cmd: "vp test run packages/offline/src/docs-examples.test.ts",
    slow: true,
  },
  {
    id: "WI-5 agents-consumer-index",
    desc: "AGENTS.md has a consumer index pointing to the package READMEs and llms.txt",
    cmd: "rg -q 'packages/core/README' AGENTS.md && rg -q 'llms.txt' AGENTS.md",
  },
  {
    id: "WI-11 readme-sections",
    desc: "Every package README has install + usage(```ts) + API sections",
    cmd:
      "for p in core lang offline test unplugin; do " +
      "rg -qi 'install' packages/$p/README.md && rg -q '```ts' packages/$p/README.md " +
      "&& rg -qi '## .*API|## Usage|## Reference' packages/$p/README.md || exit 1; done",
  },
  {
    id: "WI-11 readme-old-api",
    desc: "Every package README has zero old API",
    cmd: `test "$(rg -cP '${OLD_API}' packages/*/README.md README.md 2>/dev/null | awk -F: '{s+=$2} END{print s+0}')" = "0"`,
  },
  {
    id: "WI-12 root-readme-logo",
    desc: "Root README has the unworklet logo + package index, and the logo asset exists",
    cmd:
      "rg -q 'unworklet-logo-chain' README.md && test -f assets/unworklet-logo-chain.svg " +
      "&& rg -qi 'quick start|getting started' README.md",
  },
  {
    id: "WI-6 browser-verify",
    desc: "Real-browser visual-inspection artifacts for every panel (graph/state/signals/midi)",
    cmd:
      "test -f plans/artifacts/browser-verify-signals.json " +
      "&& test -f plans/artifacts/browser-verify-midi.json " +
      "&& test -f plans/artifacts/browser-verify-graph.json " +
      "&& test -f plans/artifacts/browser-verify-state.json",
  },
  {
    id: "WI-7 event-direction (#40 = keep flat, documented)",
    desc: "#40 stays as-is and is documented (per-name narrowing is v1.x); the type/doc explicitly states the flat surface",
    cmd: "rg -q 'deferred to' packages/core/src/types.ts && rg -q 'flat .Record' docs/05-client.md",
  },
  {
    id: "WI-8 prev-slot-type",
    desc: "#47 test that determines the $prev slot type from the return value is green",
    cmd: "vp test run packages/lang/src/__sugar__/prev.test.ts",
    slow: true,
  },
  {
    id: "WI-9 roadmap-status",
    desc: "Artifact reconciling the A1-F1 status in 10-roadmap with reality",
    cmd: "test -f plans/artifacts/roadmap-status.md",
  },
  {
    id: "FINAL vp-check",
    desc: "vp check is green across the entire workspace",
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

const mark = (s) =>
  s === "PASS" ? "\x1b[32m✓\x1b[0m" : s === "FAIL" ? "\x1b[31m✗\x1b[0m" : "\x1b[2m–\x1b[0m";
for (const [status, id, desc] of results) {
  console.log(`${mark(status)} ${id.padEnd(32)} ${desc}`);
}
console.log(`\n${pass} pass / ${fail} fail${FAST ? " (fast: slow gates skipped)" : ""}`);
process.exit(fail === 0 ? 0 : 1);
