# Open questions

余 湖 さ ん の judgment が 要 る 質 問 リ ス ト。 ratify さ れ た ら `decisions-log.md` に 移 し て こ の file か ら 削 る。 浮 上 し た 質 問 は 末 尾 に 追 加。

---

## Q-A. swap 累 積 warning の 閾 値 + 文 言

`replaceProcessor` で 同 AudioContext 内 で N 回 swap 累 積 で `console.warn` を 出 す path (Q50 で ratify 済 み)。 N の 値 + message 文 言 を ど う 決 め る か、 ま た は warning ナ シ で 進 め る か。 関 連 doc = `05-client.md` §8.5。

## Q-B. live coding canonical recipe を 入 れ る か

`replaceProcessor` を 軸 に し た live coding / visual programming の canonical recipe を `12-canonical-examples.md` か 新 recipe 集 に 1 例 追 加 す る か。 (Q50)

## Q-C. per-block で の `audioIn.at(c, k != 0)` 範 囲 check 仕 様

Q51 で `audioIn.at(c, 0)` を per-block で 開 放 済 み。 0 以 外 の compile-time-constant `k` で の 範 囲 check (= `[0, SAMPLES_PER_BLOCK - 1]`) を 静 的 解 析 で か け る か、 か け ず に 任 意 literal を 受 け 入 れ る か。 関 連 doc = `03-compiler.md` §2.4。

## Q-D. per-block 呼 び の canonical use case 例 を 追 加 す る か

per-block で の sample-offset primitive 呼 び (= block-start input level 検 査 + adaptive 処 理 等) の canonical example を `12-canonical-examples.md` か 新 recipe で 1 例 追 加 す る か。 (Q51)

## Q-E. voice allocation recipe を 入 れ る か

polyphony / voice stealing の recipe を `docs/recipes/` に 入 れ る か。 canonical Ex 8 で 4-voice mono synth カ バ ー 済 み。

## Q-F. overlap-add recipe を 入 れ る か

STFT 由 来 の overlap-add の recipe を `docs/recipes/` に 入 れ る か。
