# Step 1.3 — Scalar 乗 算 (= f32 in / f32 out + literal)

## このコードが やる こと (= big picture)

`build.ts` を 走 ら せ る と、 「`gain` と い う 名 前 の function を 1 つ 持 ち、 引 数 1 個 (= f32) を 受 け 取 っ て、 関 数 内 で `0.5` (= f32 immediate) を 掛 け た 結 果 を return す る」 WASM module を binaryen で 構 築 + emit。

`run.ts` で `gain(2.0)` を 呼 び 出 し、 return 値 が `1.0` (= 2.0 × 0.5) で あ る こ と を assert。

**Step 1.2 か ら の 差 分**:

- **i32 → f32 へ 型 変 更** = parameter / result / immediate / arithmetic 全 部 f32
- **f32.const で immediate を stack に push** (= step 1.1 の `i32.const 42` の f32 版)
- **f32.mul で binary 乗 算** = stack の 2 operand を pop し て 乗 算、 結 果 を push = **WASM stack machine の binary op model** が 初 め て 出 る
- **JS ↔ WASM f32 marshalling** = step 1.2 の i32 marshalling と 比 較

つ ま り = **WASM の stack machine 上 で 「operand を 順 番 に push し て binary op が 2 個 consume + 1 個 push」 path を 把 握** + **f32 arithmetic + immediate** を 1 か 所 で 確 認 す る 試 行。 unworklet 文 脈 で は audio sample × constant gain の 最 小 path (= `forSample((i) => output.ch(0).at(i).write(input.ch(0).at(i).mul(num(0.5))))` の compile 後 形 の 雛 形)。

## emit さ れ る `.wat`

```wat
(module
 (type $0 (func (param f32) (result f32)))
 (export "gain" (func $gain))
 (func $gain (param $0 f32) (result f32)
  (f32.mul
   (local.get $0)
   (f32.const 0.5)
  )
 )
)
```

Step 1.2 か ら の 変 更:

- L2 type = `(func (param f32) (result f32))` (= i32 → f32 に 型 変 更)
- L4 func = `(param $0 f32) (result f32)` + body = `(f32.mul (local.get $0) (f32.const 0.5))`
- body が **3 行 nest** = `f32.mul` の 子 が `local.get` + `f32.const` = stack machine の binary op を S-expression で 表 現 し た 形

## 行 ご と

- **L1 `(module ...)`** = root node
- **L2 `(type $0 (func (param f32) (result f32)))`** = type section = signature 「f32 1 個 → f32 1 個」
- **L3 `(export "gain" (func $gain))`** = export section
- **L4-9 `(func $gain (param $0 f32) (result f32) (f32.mul (local.get $0) (f32.const 0.5)))`** = func section:
  - body = `(f32.mul ...)` = 「2 operand を pop し て 乗 算、 結 果 を push」 1 instruction
  - 子 1 = `(local.get $0)` (= param 0 番 を stack に push)
  - 子 2 = `(f32.const 0.5)` (= immediate 0.5 を stack に push)
  - 実 行 順 = (1) `local.get 0` で param push → (2) `f32.const 0.5` で 0.5 push → (3) `f32.mul` で 2 個 pop し て 乗 算、 結 果 push → function 終 了 で stack top が return

## 新 出 keyword (= Step 1.2 と の 差 分)

| token | 種 別 | 説 明 |
|---|---|---|
| `f32` | WASM 型 keyword (= 不 変) | 32-bit IEEE 754 floating point 型 |
| `f32.const` | WASM instruction (= 不 変) | f32 immediate value を operand stack に push |
| `f32.mul` | WASM instruction (= 不 変) | stack top 2 個 を pop し て 乗 算、 結 果 を push (= **binary op**) |
| `0.5` | **任 意 (= user 数 値)** | f32 immediate、 `build.ts` の `mod.f32.const(0.5)` 引 数 |

## WASM stack machine の binary op model (= 新 出 概 念、 重 要)

step 1.1 / 1.2 で は instruction が **stack top に 1 個 push す る だ け** だ っ た:

- `i32.const 42` = 42 push (= 0 → 1)
- `local.get 0` = first param push (= 0 → 1)

step 1.3 で は **binary op** が 初 出 = stack top 2 個 を pop し て 1 個 push す る instruction:

```
[実 行 前 ]            stack: [        ] (= 空)
local.get $0   →     stack: [ 2.0    ]
f32.const 0.5  →     stack: [ 2.0 0.5 ]
f32.mul        →     stack: [ 1.0    ] (= 2.0 × 0.5)
(= function 終 了)   return = stack top = 1.0
```

WASM の 大 半 の arithmetic op (= `f32.mul` / `f32.add` / `i32.add` / `i32.mul` / `f32.div` 等) は **2 個 pop + 1 個 push** の binary op。 unary op (= `f32.neg` 等) は 1 個 pop + 1 個 push。 比 較 op (= `f32.lt` 等) は 2 個 pop + 1 個 push (= 結 果 は 0 / 1 の i32)。

つ ま り **operand を 「使 う 順 に 」 stack に push し て、 op で consume さ せ る** = WASM の S-expression 表 現 で は `(op operand1 operand2)` 形 で **operand を nest で 書 く と 実 行 順 番 が 自 動 で 決 ま る** (= 子 を 左 か ら 順 に 評 価 し て stack に push し、 親 op で consume)。

## binaryen API ↔ `.wat` 対 応

```typescript
mod.addFunction(
  "gain",
  binaryen.f32,
  binaryen.f32,
  [],
  mod.f32.mul(                      // body root = f32.mul
    mod.local.get(0, binaryen.f32), // operand 1
    mod.f32.const(0.5),             // operand 2
  ),
);
```

| build.ts | .wat 出 力 |
|---|---|
| `mod.f32.mul(a, b)` | `(f32.mul <a-emit> <b-emit>)` |
| `mod.local.get(0, binaryen.f32)` | `(local.get $0)` |
| `mod.f32.const(0.5)` | `(f32.const 0.5)` |

binaryen API は **expression tree を nest で 組 み 立 て る** = WASM S-expression と 1:1 対 応。 `mod.f32.mul(opA, opB)` は f32.mul の AST node を return す る、 そ れ を 別 の op に 渡 し て さ ら に nest 可 能。

例 (= 後 続 step で 出 る) = `gain × volume + bias` の 形:

```typescript
mod.f32.add(
  mod.f32.mul(sample, gain),
  bias,
);
```

→ .wat: `(f32.add (f32.mul ... ...) ...)`

## JS ↔ WASM f32 marshalling (= step 1.2 i32 と 比 較)

| 方 向 | 動 作 |
|---|---|
| JS number → WASM f32 | JS double (= f64) を **f32 に narrow** (= 精 度 落 ち る、 exact f32 で 表 現 で きな い 数 値 (= 例: 0.1) は 近 似 値 に な る) |
| WASM f32 → JS number | f32 を JS double に **widen** (= exact、 f32 の bit pattern は f64 に 完 全 保 存 可) |

step 1.3 で の 数 値 `0.5` + `2.0` は 全 て **exact f32 で 表 現 可** (= 2 の べ き 乗 系) = 精 度 落 ち ナ シ で `gain(2.0) = 1.0` が exact 一 致。 一 方 `0.1` 等 は exact f32 ナ シ = JS で `0.1` を 渡 す と f32 に narrow さ れ て 微 小 誤 差 が 入 る。

step 1.2 i32 marshalling と 比 較:

| 型 | JS → WASM | WASM → JS |
|---|---|---|
| i32 | 32-bit truncate (= 小 数 切 り 捨 て + overflow wraparound) | signed lift (= -2^31〜2^31-1 範 囲、 exact) |
| f32 | f64 → f32 narrow (= 精 度 落 ち、 NaN / Inf 保 存) | f32 → f64 widen (= exact 保 存) |

## host JS が WASM を 呼 ぶ 経 路 (= `run.ts`)

```typescript
const { instance } = await WebAssembly.instantiate(wasm);
const gain = instance.exports.gain as (sample: number) => number;
console.log(gain(2.0)); // → 1.0
```

TS の type annotate = `(sample: number) => number` (= JS で は f32 も f64 も `number`、 binary 上 で f32 と し て 処 理 さ れ る か は WASM signature で 決 ま る、 JS は 透 過)。

## 学 習 axes (= こ の step で 把 握 す る 概 念)

1. **WASM stack machine の binary op model**: arithmetic op (= `f32.mul` 等) は stack top 2 個 を pop し て 1 個 push。 S-expression `(op a b)` 形 で 子 を 順 に 評 価 + 親 op で consume す る path。
2. **f32 type + f32.const + f32.mul**: i32 と 別 instruction family、 同 型 op だ け で 演 算 (= mixed i32 + f32 は **explicit cast 必 要**、 後 続 step で 出 る)。
3. **JS ↔ WASM f32 marshalling**: JS number ↔ WASM f32 は f64 ↔ f32 conversion 経 由、 精 度 落 ち の 軸 (= 0.5 / 2.0 等 は exact、 0.1 等 は 近 似)。
4. **binaryen の expression tree**: AST node を method 呼 び 出 し で nest で 組 み 立 て る = WASM S-expression と 1:1 対 応 す る design。
5. **unworklet 文 脈 で の 雛 形**: audio sample × constant gain (= `output.ch(0).at(i).write(input.ch(0).at(i).mul(num(0.5)))`) の compile 後 形 の 最 小 形。

## 実 行 手 順

```sh
vp exec tsx step-1.3/build.ts   # → expected.wat + gain.wasm 出 力
vp exec tsx step-1.3/run.ts     # → gain(2.0) = 1.0 確 認
```

## Deliverable

- `build.ts` = binaryen で IR 構 築 + `.wat` / `.wasm` emit
- `run.ts` = `gain.wasm` を instantiate し て `gain(2.0) = 1.0` 確 認
- `expected.wat` = `build.ts` 出 力 snapshot、 commit 済 = regression 防 止
- `gain.wasm` = binary artifact、 `.gitignore` 対 象
