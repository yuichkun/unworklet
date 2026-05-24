# Step 1.6 — Bounded loop 単 独 (= counter increment only)

## このコードが やる こと (= big picture)

`build.ts` を 走 ら せ る と、 「local i32 counter `i` を 0 か ら 始 め て 1 ずつ increment、 i が 128 に な っ た ら 抜 け、 最 終 値 (= 128) を memory[0] に store す る `countTo128` function」 を WASM で 構 築 + emit。

`run.ts` で:

1. `countTo128()` 呼 び 出 し
2. `view[0]` (= memory[0..3] を i32 と し て 読 む) が `128` で あ る こ と を assert

memory I/O は 「最 終 値 を 1 回 store す る」 だ け = memory access は 単 純、 **loop control flow 単 独 の 把 握 に focus**。 memory + arithmetic と loop の 組 合 せ は step 1.7 で 拡 張。

unworklet 文 脈 で の 雛 形 = **`forSample((i) => ...)` の `for (i = 0; i < 128; i++)` 部 分 単 独** = WASM で どう loop を 表 現 す る か の 最 小 例。

## emit さ れ る `.wat` (= 期 待 形)

```wat
(module
 (type $0 (func))
 (memory $0 1 1)
 (export "memory" (memory $0))
 (export "countTo128" (func $countTo128))
 (func $countTo128
  (local $0 i32)
  (local.set $0
   (i32.const 0)
  )
  (block $break
   (loop $continue
    (br_if $break
     (i32.ge_s
      (local.get $0)
      (i32.const 128)
     )
    )
    (local.set $0
     (i32.add
      (local.get $0)
      (i32.const 1)
     )
    )
    (br $continue)
   )
  )
  (i32.store
   (i32.const 0)
   (local.get $0)
  )
 )
)
```

注: binaryen の emit 形 で は `block` の 直 接 子 が 1 instruction の 場 合 (= こ こ で は loop が 直 接 子) 中 間 block を 省 略 す る 可 能 性 あ り。 実 際 の emit と diff が 出 た ら build.ts 出 力 で 確 認 (= `expected.wat` 自 動 生 成 さ れ る た め、 こ こ で の prose は 想 定 形 + 実 際 は emit 後 に snapshot fix さ れ る)。

## 行 ご と の 役 割

- **L1-2**: module + type (= function 引 数 ナ シ + result ナ シ)
- **L3-4**: memory + memory export
- **L5**: function export
- **L6 `(func $countTo128 ...)`**: function body
  - **L7 `(local $0 i32)`**: local variable declare = i32 1 個 (= counter `i`、 local-id `$0`)
  - **L8-10 `(local.set $0 (i32.const 0))`**: i = 0
  - **L11 `(block $break ...)`**: block declare + label `$break` (= forward escape target)
  - **L12 `(loop $continue ...)`**: loop declare + label `$continue` (= backward jump target)
  - **L13-18 `(br_if $break (i32.ge_s (local.get $0) (i32.const 128)))`**: 「if (i >= 128) br $break」 = i が 128 以 上 な ら $break label へ jump (= block を 抜 け る)
  - **L19-24 `(local.set $0 (i32.add (local.get $0) (i32.const 1)))`**: i = i + 1
  - **L25 `(br $continue)`**: $continue label へ jump (= loop 先 頭 に 戻 る)
  - **L26-30 `(i32.store (i32.const 0) (local.get $0))`**: memory[0] = i (= counter 最 終 値)

## 新 出 keyword

| token | 種 別 | 説 明 |
|---|---|---|
| `local` (= declare) | WASM keyword (= 不 変) | function 内 で local variable を declare す る 構 文 |
| `local.set` | WASM instruction (= 不 変) | stack top 1 個 pop し て local index N に 書 き 込 む |
| `block` | WASM keyword (= 不 変) | structured control flow の block declare、 label 付 き で **forward escape target** に な る |
| `loop` | WASM keyword (= 不 変) | structured control flow の loop declare、 label 付 き で **backward jump target** に な る |
| `br` | WASM instruction (= 不 変) | unconditional branch = 指 定 label へ jump |
| `br_if` | WASM instruction (= 不 変) | conditional branch = stack top の i32 が 非 ゼ ロ な ら 指 定 label へ jump |
| `i32.ge_s` | WASM instruction (= 不 変) | signed greater-equal = stack top 2 個 pop し て 比 較、 結 果 i32 (= 0 or 1) を push |
| `i32.add` | WASM instruction (= 不 変) | i32 addition = 2 個 pop + 1 個 push |
| `i32.store` | WASM instruction (= 不 変) | memory に i32 を store = `(offset, align, ptr, value)` 4 引 数 |
| `$break` / `$continue` | **任 意 (= user 命 名)** | block / loop の label = `br` / `br_if` で 引 く target、 source-level の 慣 用 命 名 |

## WASM の structured control flow model (= 新 出、 重 要)

WASM は **goto ナ シ + 構 造 化 control flow** = `block` / `loop` / `if` の nest で 制 御。

### `block` vs `loop` の **本 質 的 違 い** = `br` の jump 先

```
(block $L
  ...
  br $L    ←  $L label へ jump = block の 「後 ろ」 へ jump = 抜 け る (= forward escape)
  ...
)
(後 続 code)  ←  ここ に 戻 る
```

```
(loop $L
  ...
  br $L    ←  $L label へ jump = loop の 「先 頭」 に jump = 戻 る (= backward = repeat)
  ...
)
(後 続 code)  ←  loop body が br $L で 戻 る 限 り こ こ に は 到 達 し ない、 br ナ シ で fall-through 抜 け る と こ こ
```

= **同 じ `br $label` instruction で あ っ て も、 label が block か loop か で forward / backward が 決 ま る**。 これ が WASM の 設 計 = goto ナ シ で loop / break / continue を 構 造 化 で 表 現。

### 「break」 「continue」 の WASM 表 現

伝 統 的 言 語 の `break` / `continue` を WASM に 翻 訳:

- **break (= loop を 抜 け る)** = loop を 包 む 外 側 の **block の label に br** (= forward escape)
- **continue (= loop 先 頭 に 戻 る)** = loop の label に br (= backward = repeat)

step 1.6 の 形:

```
(block $break              ←  break label = forward escape target
  (loop $continue          ←  continue label = backward jump target
    (br_if $break ...)     ←  break (= 条 件 付 き で block の 後 ろ へ)
    ...                    ←  body
    (br $continue)         ←  continue (= 無 条 件 で loop 先 頭 に 戻 る)
  )
)
```

= 「`block` で break target を 包 ん で、 中 に `loop` で continue target を 置 く」 が 慣 用 形。

### `br` / `br_if` の semantics

- `br $L` = 無 条 件 で $L へ jump、 後 続 instruction は dead code
- `br_if $L` = stack top の i32 を pop し て 「非 ゼ ロ な ら $L へ jump、 0 な ら 何 も せ ず 次 へ」

step 1.6 で = `br_if $break` の 条 件 は `i32.ge_s(local.get 0, i32.const 128)` = 「i >= 128」 = 結 果 i32 (= 1 か 0)、 1 な ら break。

### 比 較 op の return type

WASM に は **bool 型 ナ シ** = 比 較 op (= `i32.ge_s` / `i32.eq` / `f32.lt` 等) は **結 果 を i32 (= 0 or 1) で 表 現**。 `br_if` 等 は 「i32 の 非 ゼ ロ で jump」 と い う semantics で bool ナ シ で 動 く。

## local variable declare + `local.set`

- `(local $name i32)` = function 内 で local var を declare、 type = i32
- local index = parameter の 後 ろ に 続 く 採 番 = step 1.6 = param 0 個 + local 1 個 = local index 0 = `$0`
- `local.set N` = stack top を local N に 書 き 込 む (= pop + write)
- `local.get N` = local N の 値 を stack に push (= read + push)

## `i32.store` の signature

```
i32.store offset align ptr value
        └─u32┘ └─u32┘ └─i32 expr┘ └─i32 expr┘
```

= 4 引 数:

- **`offset`** = static byte offset (= load と 同 形)
- **`align`** = alignment hint (= i32 default = 4)
- **`ptr`** = i32 expression = address base (= stack か ら pop)
- **`value`** = i32 expression = store 値 (= stack か ら pop)

load (= 3 引 数 = offset / align / ptr) と の 差 分 = value 引 数 追 加 (= store す る 値 を 別 expression で 渡 す)。 stack 動 作:

```
[実 行 前 ]               stack: [        ]
<ptr-emit>         →    stack: [ ptr    ]
<value-emit>       →    stack: [ ptr val ]
i32.store          →    stack: [        ]   ; 2 個 pop + memory に write
```

## binaryen API ↔ `.wat` 対 応

```typescript
mod.addFunction(
  "countTo128",
  binaryen.none,
  binaryen.none,
  [binaryen.i32],                     // local i32 1 個
  mod.block(null, [
    mod.local.set(0, mod.i32.const(0)),
    mod.block("break", [
      mod.loop("continue", mod.block(null, [
        mod.br_if("break",
          mod.i32.ge_s(
            mod.local.get(0, binaryen.i32),
            mod.i32.const(128),
          ),
        ),
        mod.local.set(0,
          mod.i32.add(
            mod.local.get(0, binaryen.i32),
            mod.i32.const(1),
          ),
        ),
        mod.br("continue"),
      ])),
    ]),
    mod.i32.store(0, 4,
      mod.i32.const(0),
      mod.local.get(0, binaryen.i32),
    ),
  ]),
);
```

| build.ts | .wat 出 力 |
|---|---|
| `[binaryen.i32]` (= 4 引 数) | `(local $0 i32)` |
| `mod.block(null, [...])` | `(block ...)` (= label ナ シ = nullable label、 沈 黙 で omit さ れ る 可 能 性) |
| `mod.block("break", [...])` | `(block $break ...)` |
| `mod.loop("continue", body)` | `(loop $continue body)` |
| `mod.br_if(label, cond)` | `(br_if $label <cond>)` |
| `mod.br(label)` | `(br $label)` |
| `mod.local.set(idx, val)` | `(local.set $<idx> <val>)` |
| `mod.i32.ge_s(a, b)` | `(i32.ge_s <a> <b>)` |
| `mod.i32.add(a, b)` | `(i32.add <a> <b>)` |
| `mod.i32.store(off, align, ptr, val)` | `(i32.store <ptr> <val>)` (= off / align が default で 省 略) |

注: `mod.block(null, [...])` = label ナ シ sequence = 複 数 instruction を 順 次 並 べ る 用 途 (= function body root が 1 expression な の で multi-instruction を block で wrap)。

## host JS が WASM を 呼 ぶ 経 路 (= `run.ts`)

```typescript
const memory = instance.exports.memory as WebAssembly.Memory;
const view = new Int32Array(memory.buffer);        // i32 view
const countTo128 = instance.exports.countTo128 as () => void;
countTo128();
console.log(view[0]);                              // → 128
```

step 1.4 / 1.5 で は `Float32Array` view、 step 1.6 で は `Int32Array` view = memory 同 一 だ が typed view が 異 な る = 同 ArrayBuffer を **複 数 view で 別 角 度 か ら 引 く** 慣 用 path (= 後 続 step で f32 + i32 mixed access)。

## 学 習 axes (= こ の step で 把 握 す る 概 念)

1. **WASM structured control flow**: goto ナ シ、 `block` / `loop` / `if` の nest で 制 御。 GOTO 系 言 語 と は 全 く 別 model。
2. **`block` vs `loop` の `br` jump 先**: 同 `br $L` で あ っ て も block label = forward escape、 loop label = backward repeat = **label が 何 を 指 す か で 動 作 が 決 ま る**。
3. **break / continue の WASM 表 現**: 外 側 block + 内 側 loop の nest、 br_if $break で break、 br $continue で continue。
4. **比 較 op が i32 (= 0/1) を return**: WASM に は bool 型 ナ シ、 比 較 op の 結 果 は i32、 `br_if` は 「非 ゼ ロ で jump」 semantics で zip。
5. **local variable declare + local.set/get**: param と 同 一 namespace、 declare 順 で index 採 番 (= param N 個 + local M 個 = local index 0..N+M-1)。
6. **`i32.store(offset, align, ptr, value)` 4 引 数**: load と の 差 分 = value 引 数 追 加、 stack 動 作 = ptr push + value push + store で 2 pop。
7. **`Int32Array` view + `Float32Array` view の 共 存**: 同 ArrayBuffer を 別 typed view で 引 け る = byte 列 を i32 と し て も f32 と し て も 解 釈 可 能。

## 実 行 手 順

```sh
vp exec tsx step-1.6/build.ts   # → expected.wat + counter.wasm 出 力
vp exec tsx step-1.6/run.ts     # → view[0] = 128 確 認
```

## Deliverable

- `build.ts` = binaryen で counter function を IR 構 築 + emit
- `run.ts` = host JS で WASM 実 行 + memory[0] (= i32) 確 認
- `expected.wat` = `build.ts` 出 力 snapshot
- `counter.wasm` = binary artifact
