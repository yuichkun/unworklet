# Open questions — v1.0.0 spec

未 ratify 設 計 question を 集 約 す る single source of truth。 ratify さ れ た ら `decisions-log.md` に 移 し (summary table 行 + detail entry、 同 commit)、 こ の file か ら 削 る。

## 運 用 ル ー ル

- question が 浮 上 し た 時 点 で こ の file に 追 加 (= grill 途 中 で も)、 揮 発 性 を 持 た せ な い。
- 各 entry: **何 が 未 決 / どの doc が 触 れ る / 選 択 肢 / こ の 層 に 入 れ た 理 由 / 関 連 pillar** を 揃 え る。
- 層 順 は ratify ご と に 再 評 価。 audit 由 来 の tier や issue 番 号 を そ の ま ま 流 さ な い (= 余 湖 さ ん の attention は 有 限)。
- TaskList (claude-code 進 行 管 理 側) は こ の file に 従 う。 GitHub issue 化 は v1.0.0 spec freeze 後 (L4-f) に 一 括。

## ratify 範 囲 と priority filter

**docs 読 者** = impl AI agent (= v1.0.0 ship 前 docs は impl agent が 迷 わ ず 判 断 す る ため の 仕 様、 user-facing docs = getting started / API reference / tutorials は v1.0.0 完 成 後 別 phase で 作 る、 い ま 関 心 範 囲 外)。

**ratify 範 囲** = **仕 様 invariant** (= 振 る 舞 い / 制 約 / mental model / 公 開 surface に 何 が 出 て く る か / 仕 様 内 の 矛 盾 / dangling) だ け。 TS signature 細 部 / 識 別 子 名 の 好 み / generic constraint 表 現 等 は impl AI agent が TS compiler 経 由 で 機 械 的 に 確 定 す る 領 域 (= 「曖 昧 さ を 残 す」 で は な く 「適 切 な layer に 委 譲」、 `decisions-log.md` Q53)。

**priority filter** = 「**impl AI agent に 手 放 し で 実 装 さ せ た ら 矛 盾 が 出 る か**」 を 唯 一 の judgement 軸 と す る (Q55)。 「user が 誤 解 す る」 「mental model が 揺 れ る」 「読 解 違 和 感」 等 の user-facing 視 点 で 上 げ る な = mechanical sweep 領 域、 freeze 前 に 1 batch。 真 の ★★★ は **異 な る impl agent が 異 な る judgment に 達 し て し ま う 仕 様 prose 内 の 矛 盾 / dangling** だ け。

## 5 層 filter

unworklet の pillar:

| 略 称 | 内 容 |
|---|---|
| P1 declarative | user 書 い た 構 造 が そ の ま ま WASM |
| P2 TS-first | branded `Node<T>`、 literal lift |
| P3 RT-safe | by construction、 layered enforcement |
| P4 standards | Web Audio 標 準 の み、 host 形 式 ナ シ |
| P5 minimal | primitives の み、 toolbox で は な い |
| P6 JUCE-MM | top-to-bottom process body、 forSample は loop primitive |

層 定 義:

- **Layer 1 — 真 の ★★★ = impl 矛 盾 リ ス ク 高。** 仕 様 prose 内 矛 盾 / dangling、 異 な る impl agent が 異 な る judgment に 達 す る = 矛 盾 し た 実 装 が 出 る。 余 湖 さ ん grill 必 須。
- **Layer 2 — additive surface。** v1.0.0 公 開 surface に 含 め る か decide、 含 め な い 場 合 は v1.x.0 で 追 加 可、 impl 矛 盾 リ ス ク 低 い。
- **Layer 3 — freeze 前 process / trivial 設 定 値。** v1.0.0 freeze 直 前 1 batch、 軽 量 judgment (= owner 任 せ 方 針 / acceptance criteria / license / npm scope 等)。
- **Layer 4 — mechanical sweep。** 余 湖 さ ん judgment 不 要、 freeze 前 1 batch (= decisions-log integrity / line-ref / README / docs prose 揃 え / canonical integrity 等)。
- **Layer 5 — freeze 後 / v1.x.0。** v1.0.0 ratify 範 囲 外、 freeze 後 に GitHub issue 化 or v1.x.0 docs/recipes/ で 追 加。 い ま は touch し な い。

**ID prefix の 注 釈:** entry ID (= `L1-b` / `L2-c` 等) は 歴 史 的 命 名 で **過 去 ratify / decisions-log 引 用 と の 整 合 維 持** の た め fix。 Layer 配 置 は ratify ご と に 現 priority filter (= impl 矛 盾 リ ス ク 軸) で 動 く = ID prefix と Layer 番 号 が 一 致 し な い ケ ー ス あ り。

**層 内 順 序 の 判 断 軸:**

1. **impl 矛 盾 リ ス ク** — 仕 様 prose 内 の 矛 盾 / dangling、 異 な る impl agent が 異 な る judgment に 達 す る も の が 上 位 (= ship 後 breaking)
2. **議 論 の 軽 さ** — 軽 い ratify を 先 に 片 付 け て attention を 重 い judgment に 集 中
3. **依 存 関 係** — invariant ratify 間 の 順 序 整 合

---

## Layer 1 — 真 の ★★★ (impl 矛 盾 リ ス ク 高)

(現 在 該 当 entry ナ シ — Q56 / Q57 / Q58 で 全 ratify 完 了。 後 続 grill で 新 規 dangling 発 見 時 は こ こ に 追 加 す る)

---

## Layer 2 — additive surface (v1.x.0 OK 寄 り)

(現 在 該 当 entry ナ シ — Q59 (= L3-a sumLanes) で 全 ratify 完 了。 後 続 grill で 新 規 additive surface 候 補 が 出 た 場 合 は こ こ に 追 加 す る)

---

## Layer 3 — freeze 前 process / trivial 設 定 値

(現 在 該 当 entry ナ シ — Q60 / Q61 / Q62 で 全 ratify 完 了。 後 続 grill で freeze 前 process 候 補 が 出 た 場 合 は こ こ に 追 加)

---

## Layer 4 — mechanical sweep (= 余 湖 さ ん judgment 不 要、 freeze 前 1 batch)

以 下 ratify 内 容 を 変 え ず docs を 揃 え る sweep。 1 commit で 一 括 が 望 ま し い (= AGENTS.md HARD CONTRACT の canonical integrity rule を 同 時 に 守 る)。

**M-sweep 内 順 序** = impl 開 始 前 に 必 要 な 順:

1. **L4-M1 decisions-log integrity** — Q-reference の 正 本 整 備。 他 sweep の 引 用 元 が 揃 う。
2. **L4-M2 line-ref → section-anchor** — M1 完 了 後 sweep。
3. **L4-M3 README 整 合 性** — top-level navigation の 修 正。 impl agent が 最 初 に 読 む 入 口 を fix。
4. **L4-M4 docs prose 揃 え** — vocabulary / listing / context の 一 貫 性。
5. **L4-M5 canonical examples integrity** — AGENTS.md HARD CONTRACT。 ratify 内 容 を 揃 え た 後 に。
6. **L4-M6 / L4-M7 / L4-M8** — 残 hygiene。

### L4-M5b. sysex を exercise す る canonical example 追 加 (= Ex 9 新 設、 設 計 寄 り)

Q49 ratify で worklet 側 sysex emit が `Buffer<'u8'>` + `length` 経 由 で 完 全 spec 化 さ れ た が canonical example で exercise ナ シ = AGENTS.md HARD CONTRACT (canonical examples integrity rule) 観 点 で 重 い gap。 Ex 9 と し て sysex 1 例 を 設 計 + コ ー ド 追 加 + Coverage table 反 映。 余 湖 さ ん の use case 選 定 → 設 計 → 実 装 path で 進 行 (= L4-M5 mechanical sweep か ら 切 り 出 し、 sweep 完 了 後 別 grill 経 由 で 実 施)。 TaskList #101。

### L4-M6. detail entry の Open follow-up 集 約

各 detail entry 末 尾 に 散 在 す る Open follow-up bullet を 1 surface に 集 約 (= session resume で 見 え る surface へ)。 audit C §7 拾 い。

- Q22-d L878: stable error ID inventory の doc 化 → L4-M7 と 統 合 (= 1 docs entry 追 加)。
- Q23+Q24+Q25 L2016: 6 bullets (analysis JSON schema / vite plugin HMR payload / offline generic type / test matcher list / source map detail / COOP-COEP dev warning) → 各 doc の placeholder section 化 (= L4-M3 status table 更 新 ご と)。
- Q11 L1952: 2 bullets (COOP/COEP detect failure warning shape、 future-quirk adjudication doc) → docs polish 任 せ。
- Q50 L2081: 3 bullets (accumulation warning threshold、 oldNode `process()` signaling、 live-coding canonical recipe) → docs polish 任 せ。
- Q51 L2117: 2 bullets (per-block `audioIn.at(c, k)` non-zero literal range check、 per-block call canonical use case) → docs polish 任 せ。

### L4-M7. Stable error ID inventory を docs に

`03-compiler.md` §2.5 (L142) + Q22-d 末 尾 で 「The list of stable error IDs is maintained as a separate inventory」 と 書 い て あ る が docs 内 に inventory 不 在。 v1.0.0 で stable surface を 約 束 し て い る の で 1 docs section 追 加。 audit A §1 + §5 拾 い。

### L4-M8. Q28 番 号 gap 説 明

`decisions-log.md` index で Q1 → Q2 → ... → Q27 → Q29 と Q28 が 飛 ぶ。 intentional skip か 番 号 ア ー テ ィ フ ァ ク ト か 1 行 注 釈。 audit A §3 + C §4 拾 い。

### L4-M9. Temporal expression sub-agent sweep

docs prose (= `docs/*.md`、 `12-canonical-examples.md` 含 む 全 docs) に 残 存 す る temporal / chronological 表 現 を sub-agent parallel sweep で 拾 い 上 げ + 現 在 形 prose に 書 き 換 え。 user global CLAUDE.md 「Code Comment Guidelines」 = docs prose に も 同 様 適 用、 v1.0.0 正 本 prose に 「earlier draft / retired / previously / originally / used to / historical / legacy / formerly / deprecated / moved to / has been / was retired / in the past / recently / now (vs then 含 意)」 等 を 書 か な い。 L4-M1〜M8 sweep 完 了 後 の **最 終 関 門** = mechanical sweep 群 が 全 部 着 地 し て か ら docs 全 体 を agent 軸 で grep + rewrite proposal 出 す、 漏 れ ナ シ で 拾 う。 [[docs-live-document-no-temporal]] 累 犯 認 識 反 映 (2026-05-20)。

---

## Layer 5 — freeze 後 / v1.x.0 (= v1.0.0 ratify 範 囲 外)

v1.0.0 ship 完 了 後 に 触 れ る entry。 い ま grill 対 象 外、 freeze 後 GitHub issue 化 or v1.x.0 docs/recipes/ で 追 加。

### L4-d. `docs/recipes/` voice allocation pattern

Polyphony / voice stealing を recipe doc 化 す る か。 canonical Ex 8 で 4-voice mono synth カ バ ー、 v1.0.0 ship 必 須 で は な い。 v1.x.0 補 完 docs と し て 後 で 検 討。

### L4-e. `docs/recipes/` overlap-add pattern

STFT 由 来 の Overlap-Add の recipe。 L4-d と 同 様 v1.0.0 ship 必 須 で は な い。

### L4-f. Issue-ize the finalized v1.0.0 spec

こ の `open-questions.md` が freeze 状 態 に な っ た 時 点 で、 ratify 済 み 設 計 + 残 task を GitHub issues に 1-to-1 化、 `v1.0.0` milestone を 付 け て impl agent 群 に 流 す。 そ れ ま で は こ の file が canonical。

---

## 新 規 question の 追 加 場 所

新 し く 浮 上 し た question は 末 尾 に 暫 定 layer を 付 け て 追 加 し、 次 の ratify 時 に 並 び 替 え る。

---

## audit 出 力 ア ー カ イ ブ

こ の 並 び 直 し の base に な っ た 3 つ の sub-agent audit:

- `/var/folders/.../audit-A-undecided.md` — Prose 内 未 確 定 標 識 / placeholder vs spec 矛 盾 / dead Q-ref / type signature 不 完 全 / v1.0.0 約 束 vs 未 定 義 / canonical drift (6 + 8 + 5 + 5 + 3 + 5 = 32 件)
- `/var/folders/.../audit-B-consistency.md` — cross-doc consistency (同 概 念 別 表 現 / 同 規 則 別 判 定 / package drift / 識 別 子 揺 れ / Q-ref drift / Status TOC drift / canonical vs spec drift、 18 件)
- `/var/folders/.../audit-C-decisions-log.md` — decisions-log integrity (summary 無 detail × 7 件 + Q22 drift × 3 + line-ref drift 体 系 + open follow-up × 5 entry 群)
