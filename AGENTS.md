# AGENTS.md

Guidance for AI agents implementing unworklet v1.0.0.

## What this repository is

A from-scratch implementation of `unworklet` — a TypeScript-first framework for declarative Audio Worklet DSP, compiled to WebAssembly. The v1.0.0 implementation is being driven by AI agents working in parallel against the specifications in `docs/`.

## Source of truth

- **`docs/`** is the authoritative specification. Read `docs/README.md` first to learn the read order and which component you own. Every component doc links to `docs/decisions-log.md` for the "why" behind any decision.
- If your work touches an area that is not yet covered in `docs/`, **stop and surface the gap** to the human reviewer rather than inventing the missing decision.

## Canonical examples integrity rule (HARD CONTRACT)

`docs/12-canonical-examples.md` is the **integrity anchor** for the entire spec. It is a curated set of self-contained, end-to-end plugin examples that exercise the full surface of unworklet (every primitive, every declaration, every main-side method). Any change to any other file in `docs/` — primitive shapes, declaration shapes, surface listings, decisions, transport contracts — must be cross-checked against the examples there before the change is accepted.

**Required process when modifying any `docs/*.md` (other than `12-canonical-examples.md` itself)**:

1. Identify which examples in `12-canonical-examples.md` exercise the surface you are changing (the `## Coverage` table at the top of that doc maps concept → example numbers).
2. Apply the proposed change to those examples (mentally or as a draft) and verify they still:
   - Compile under the changed surface (no broken signatures, types, or references).
   - Make sense for the realistic use case the example was designed for (no awkward workarounds, no apologetic comments).
   - Preserve the user's mental-model simplicity — the change should not force a production-grade audio plugin author to re-learn a concept they already understood.
3. **If any example breaks or becomes awkward, the proposed change is rejected** until either (a) the change is revised to preserve the example, or (b) the example is updated together with the change as a single coherent revision (and the resulting UX cost is made visible to the human reviewer in the same diff).

This rule is non-negotiable. Spec changes that pass review without an accompanying check against `12-canonical-examples.md` are **out of process**.

The same rule applies in the reverse direction: changes to `12-canonical-examples.md` itself trigger a re-read of the affected component docs to ensure the new example shape matches the spec — examples cannot drift from the spec, the spec cannot drift from the examples.

The purpose of this rule is to keep one question answerable at any time during spec evolution: **"is the user experience still simple, coherent, and production-ready?"** If the canonical examples no longer read that way, the spec change is the wrong shape regardless of how clean it looks in isolation.

## Implementation invariant (HARD CONTRACT)

unworklet v1.0.0 は 14 phase の vertical slice 構造 で 段階 構築 する (= `docs/10-roadmap.md` §2)。 各 phase で の **minimal 実装 / vertical slice 実装 は 設計 上 OK** だ が、 以下 は **絶対 ナシ**:

1. **docs 規定 と 乖離 し た ad hoc 実装** — 公開 API surface (= 公開 type / 引数 形 / 戻り値 形、 09-repo-structure.md §2.1 + §2.2 + 各 component doc 規定) は docs 規定 と zip。 phase 内 で 「とりあえず 違う 形 で 出して 後 で 直す」 は 不可。
2. **前方 互換性 ナシ 実装** — 後続 phase で 追加 さ れる surface (= 例: declaration kind 追加、 new primitive 追加、 main side method 追加、 messaging surface 拡張) と 衝突 する 設計 は 不可。 phase 内 で 実装 する 範囲 は 必ず 最終 アーキテクチャ 像 の **subset** で あり、 後続 phase で **superset** に 拡張 し て いく shape。

各 phase 着手 時、 触る surface に 関わる docs (= `00-foundations.md` / `01-dsl.md` / 各 component doc / `decisions-log.md` の 該当 Q) を 必ず 参照、 最終 像 の subset として 実装 する。 「minimal = 動く だけ で OK」 と 「ad hoc = 後 で 大幅 rewrite」 は 違う。

skeleton phase (= `docs/10-roadmap.md` §2 Phase 2 等) で も **公開 type は 最終 形 で declare**、 中身 は stub 実装 (= `throw new Error('not implemented')` 等) で OK、 ただし 公開 型 / 引数 形 / 戻り値 形 は docs 規定 と 一致 さ せる。 後続 phase は declared surface の 中身 を 順次 fill する path。

このルール 違反 = phase 完了 条件 を 満たさ ない、 canonical examples integrity rule と 同様 に 同 commit で の retract が 必要。

## Build, test, and lint — Vite+ only

This project uses [Vite+](https://viteplus.dev). All workflows go through `vp`. **Never invoke `npm`, `pnpm`, `yarn`, or `npx` directly** — not in shell, not in scripts, not in CI config, not in test-plan commands.

| Action                                                                          | Command                                                        |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Install deps                                                                    | `vp install` (alias `vp i`)                                    |
| Setup git hooks (= 1 度のみ、 pre-commit で staged file に vp check --fix 自動) | `vp config`                                                    |
| Add a dep                                                                       | `vp add <pkg>` (dev: `vp add -D <pkg>`)                        |
| Remove a dep                                                                    | `vp remove <pkg>` (aliases `vp rm`, `vp un`, `vp uninstall`)   |
| Update / outdated / list / why / info                                           | `vp update` / `vp outdated` / `vp list` / `vp why` / `vp info` |
| Dev server                                                                      | `vp dev`                                                       |
| Build                                                                           | `vp build`                                                     |
| Library pack                                                                    | `vp pack`                                                      |
| Tests                                                                           | `vp test`                                                      |
| Combined typecheck + lint + format                                              | `vp check` (auto-fix: `vp check --fix`)                        |
| Run a `package.json` script                                                     | `vp run <script>`                                              |
| One-off tool                                                                    | `vp dlx <pkg>` (replaces `npx`)                                |
| One-off local binary                                                            | `vp exec <binary>`                                             |

There is no `vp typecheck`, `vp tsc`, `vp vitest`, or `vp oxlint`. `vp check` covers all gates and `vp test` runs Vitest under the hood.

**Critical gotcha:** `vp dev` / `vp build` / `vp test` / `vp lint` / `vp fmt` / `vp check` always invoke the Vite+ built-in tool, NOT a same-named script in `package.json`. If `package.json` defines its own `dev` (e.g. chaining multiple processes), invoke it as `vp run dev`.

If unsure of the Vite+ equivalent for a task, consult `node_modules/vite-plus/AGENTS.md` (when installed) or fetch <https://viteplus.dev>. Falling back to `npm` / `pnpm` because something is uncertain is never acceptable.

### Imports

Do not install `vitest`, `oxlint`, `oxfmt`, `tsdown`, or `vite` directly — they are wrapped by Vite+. Import from `vite-plus`:

- `import { defineConfig } from 'vite-plus'`
- `import { expect, test, vi } from 'vite-plus/test'`

If existing code imports from `vitest` or `vite`, treat that as a bug to fix.

### Validation loop

After any change:

```sh
vp check
vp test
```

Both must pass before declaring work complete.

## Testing policy (HARD CONTRACT)

unworklet は **TDD** で 育 て る。 振 る 舞 い ベ ー ス で test ケ ー ス を 網 羅 的 に 書 い て か ら 実 装 を fill = 「先 に 実 装 を 書 い て あ と か ら test を 補 う」 path は 例 外 扱 い (= 違 反 commit を 残 す 場 合 は follow-up task で 解 消 必 須)。

### Coverage gate

- **分 岐 coverage 98% 以 上 を per-package で gate**。 1 package で も 落 ち た ら CI fail。
- provider = vitest 標 準 (= `@vitest/coverage-v8`)、 各 package の `vite.config.ts` の `test.coverage.thresholds.branches` で 98 を 設 定。
- line / function / statement coverage は 規 約 ナシ (= 余 湖 さん 明 言 軸 = branches だ け)。

### Test 配 置

- co-located `src/**/*.test.ts` (= 実 装 file の 隣 に test file)。
- 例: `packages/core/src/compile/capture.ts` の test = `packages/core/src/compile/capture.test.ts`。
- `vp pack` の build artifact (= `dist/`) は `.test.ts` を 含 ま な い (= vite-plus default 挙 動)。

### Coverage 除 外 範 囲

- **types-only file** (= 関 数 / 分 岐 ゼ ロ、 例: `packages/core/src/types.ts`)
- **公 開 surface re-export hub** (= `export` 文 だ け の `index.ts`)
- **`experiments/*`** (= Phase 1 学 習 PoC、 main impl 外)
- **`examples/*`** (= consumer 視 点 sample、 Step 3.7 等 で 動 作 test は 入 る が coverage gate scope 外)

各 package の `vite.config.ts` の `test.coverage.exclude` に 該 当 path を 列 挙 す る。

### TDD 違 反 commit が 残 る 場 合

- 該 当 commit を 出 す 前 に 余 湖 さん の 明 示 承 認 を 取 る。
- 直 後 に follow-up task を 立 ち 上 げ、 該 当 範 囲 の test を 振 る 舞 い ベ ー ス で 書 き 起 こ し て coverage 98% を 戻 す。
- follow-up task が 残 っ た ま ま 次 phase に 進 ま な い。

## Code style

- **Comments**: prefer none. When required, explain _why_, never _what_ — the code already tells the reader what it does.
- **No temporal language** in comments or docs: avoid "now", "currently", "previously", "before", "after", "used to", "updated to", "new", "old", "legacy", "originally", "initially". Git history covers change tracking.
- **Dead code**: delete it. No `_unused` rename hacks, no "removed because …" comments, no compatibility shims for unreachable cases.
- **No defensive code for impossible cases**. Trust internal callers and framework guarantees; validate only at system boundaries (user input, external APIs).
- **No premature abstractions**. Three similar lines beats a wrong helper.

## Boundaries

- Do not modify `docs/` to match the code. `docs/` is the contract; if reality has diverged, surface the mismatch to the human reviewer to fix the spec, not the spec to fit the code.
- Do not push to remote, open / close PRs, or perform shared-system actions without explicit approval.
- The realtime-safety invariants in `docs/00-foundations.md` §5 are non-negotiable: no allocation, no unbounded loops, no I/O on the audio thread, no GC-triggering operations. If a design appears to require violating one, stop and surface it.

## DevTools panel — recurring violations to avoid (HARD CONTRACT)

These 5 design directions surfaced during the 5-F panel grill and were **explicitly rejected** by the reviewer. Treat them as permanently blocked — do not re-introduce them under refactor, plan revisions, or "wouldn't it be nice if..." arguments. Each entry carries the reason so the rule survives future re-evaluation.

1. **MediaRecorder for audio capture.** Reject. WebM is browser-internal; bug reports need to be openable in any DAW or audio tool. The only sanctioned recording path is `AnalyserNode` → main-thread ring buffer (10 s rolling) → in-house 16-bit signed PCM WAV encoder. See `docs/07-vite-plugin.md` §6 Audio sub-tab.
2. **Domain-specific layout baked into the framework UI** (e.g. polysynth "voice 8 grid", envelope chips, amp meter bars). Reject. unworklet does not interpret user domain; the panel surfaces declared `state.publish` / `buffer.publish` slots through type-driven representations + a switchable dropdown. Anything beyond that is user-land UI.
3. **Jump-to-source button in the Build errors modal.** Reject. The modal already shows the source snippet + line + Why + Fix. Opening an IDE adds a side step the audio engineer didn't ask for.
4. **Swap history panel for `replaceProcessor`.** Reject. `replaceProcessor` returns `ReplaceResult` synchronously, and the Q63 accumulation warning fires once. There is no need to model a history surface — framework does not orchestrate the swap (`docs/decisions-log.md` Q50).
5. **Time-travel debugging (= scrubbing to past sample state).** Reject. Cannot satisfy realtime invariants + IIR state cannot be deterministically rewound. Use the Record sub-tab to capture short windows for offline analysis instead.

If any of these proposals re-appear in a new panel grill, the conversation stops until the proposer either argues why the rejection reason no longer applies, or the proposal is dropped.

## Mock data rule (HARD CONTRACT)

DevTools UI mocks are not decoration. They are the design contract that real composables get swapped into at Phase 6 末 尾. Therefore every mock obeys three properties:

1. **Real-world**: drawn from `docs/12-canonical-examples.md` Ex 1-10, not invented for visual polish. Slot names, port names, capacities, sysex byte patterns reflect what an actual unworklet processor would declare.
2. **Diverse**: covers every published type the framework exposes (= `state.f32` / `state.i32` / `state.bool` + `buffer.f32` / `buffer.i32` / `buffer.bool` / `buffer.u8`) through natural use cases rather than padding one type across many slots.
3. **Integrated**: values move in causally-linked ways across nodes (= polysynth meter rises → limiter gain reduction increases → reverb wet meter trails behind). A mock that puts each slot on an independent random walk fails this rule.

When adding a new mock or replacing one, verify all three before treating it as ready. A "make it pretty for the screenshot" mock is rejected on the same grounds as a domain-specific layout — both let the framework pretend to understand the user's domain.
