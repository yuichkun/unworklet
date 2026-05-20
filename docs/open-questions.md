# Open questions

余 湖 さ ん の judgment が 要 る 質 問 リ ス ト。 ratify さ れ た ら `decisions-log.md` に 移 し て こ の file か ら 削 る。 浮 上 し た 質 問 は 末 尾 に 追 加。

---

## Q-C. per-block で の `audioIn.at(c, k != 0)` 範 囲 check 仕 様

Q51 で `audioIn.at(c, 0)` を per-block で 開 放 済 み。 0 以 外 の compile-time-constant `k` で の 範 囲 check (= `[0, SAMPLES_PER_BLOCK - 1]`) を 静 的 解 析 で か け る か、 か け ず に 任 意 literal を 受 け 入 れ る か。 関 連 doc = `03-compiler.md` §2.4。
