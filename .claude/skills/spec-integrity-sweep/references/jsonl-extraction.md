# JSONL log → raw file 機械抽出 (= fallback path)

**注**: Phase 2 の primary path は 「sub-agent に直接 Write させる」 (= SKILL.md §3 Phase 2 + `references/sub-agent-prompt-template.md` Phase 1 参照)。 これは sub-agent が raw を parent message に返してしまった時の **fallback 経路**。

## 前提

- Claude Code session の JSONL log path:
  - `~/.claude/projects/<project-slug>/<session-id>.jsonl`
  - project-slug = 現在の working directory を `/` を `-` に置換 (= 例: `/Users/yuichkun/workspace/unworklet` → `-Users-yuichkun-workspace-unworklet`)
- 各 sub-agent invoke は parent message に `tool_use_id` を持ち、 sub-agent 完了の tool_result に同じ `tool_use_id` を持つ

## 抽出 script

```bash
LOG=~/.claude/projects/<project-slug>/<session-id>.jsonl
OUT=/Users/yuichkun/workspace/unworklet/audit/raw

mkdir -p "$OUT"

# (id, output filename) ペアを 12 軸分列挙
PAIRS=(
  "toolu_xxxxxxx:01-type-system.md"
  "toolu_xxxxxxx:02-boundary-crossing.md"
  "toolu_xxxxxxx:03-rt-safety.md"
  # ... 12 個 ...
  "toolu_xxxxxxx:12-test-offline.md"
)

for pair in "${PAIRS[@]}"; do
  id="${pair%%:*}"
  file="${pair##*:}"
  jq -r --arg id "$id" '
    select(.message.content[0].type? == "tool_result"
           and .message.content[0].tool_use_id? == $id)
    | .message.content[0].content
    | (try .[0].text catch .)
  ' "$LOG" > "$OUT/$file"
done
```

`(try .[0].text catch .)` は tool_result の content が string と array で混在することへの対応 (= 過去事例)。

## tool_use_id の取得

Phase 1 で 12 sub-agent を並列 dispatch した時、 各 invoke の `tool_use_id` を parent message が記録している。 通常 Agent tool 戻り値に明示されない場合は、 sub-agent 完了報告を 1 度 wait し、 session JSONL log から逆引きする path。

## primary path への回帰

fallback 1 回使ったら、 次回からは Phase 1 の sub-agent prompt で 「Write tool で `audit/raw/NN-<axis>.md` に直接書き、 parent への返事は path + 件数だけ」 を明示する path に戻る。 fallback を recurring path にしない。
