# Step 1.2 — Passthrough (= i32 in / i32 out)

## このコードが やる こと (= big picture)

`build.ts` を 走 ら せ る と、 「`passthrough` と い う 名 前 の function を 1 つ 持 ち、 引 数 1 個 (= i32) を 受 け 取 っ て そ の ま ま return す る だ け」 の WASM module を binaryen で 構 築 + emit。

`run.ts` で `instance.exports.passthrough(7)` を 呼 び 出 し、 return 値 が 7 で あ る こ と を assert。

**Step 1.1 か ら の 差 分**:

- **function に param が 入 る** = `(param $x i32)` で 引 数 declare
- **`local.get` で param を operand stack に push** = function 内 で 引 数 値 を 引 く 唯 一 path
- **JS ↔ WASM の scalar marshalling** = JS number ↔ WASM i32

つ ま り = **JS か ら WASM に scalar 引 数 を 渡 し、 そ の 引 数 を function 内 で 引 い て return す る** path を 把 握 す る 最 小 試 行。

## emit さ れ る `.wat`

```wat
(module
 (type $0 (func (param i32) (result i32)))
 (export "passthrough" (func $passthrough))
 (func $passthrough (param $0 i32) (result i32)
  (local.get $0)
 )
)
```

Step 1.1 か ら の 変 更:

- L2 type = `(func (param i32) (result i32))` (= param i32 1 個 + result i32 1 個)
- L4 func = `(param $0 i32)` 引 数 declare + body = `(local.get $0)` (= param 0 番 を stack に push)

## 行 ご と

- **L1 `(module ...)`** = root node (= Step 1.1 同)
- **L2 `(type $0 (func (param i32) (result i32)))`** = type section = signature 形 = 「i32 1 個 受 け 取 っ て i32 1 個 return」
- **L3 `(export "passthrough" (func $passthrough))`** = export section = export 名 `"passthrough"`、 中 身 = `$passthrough`
- **L4-6 `(func $passthrough (param $0 i32) (result i32) (local.get $0))`** = func section:
  - internal 名 = `$passthrough`
  - param declare = `(param $0 i32)` (= param 0 番 = i32 型)、 `$0` は binaryen 自 動 採 番 の local id
  - result type = i32
  - body = `(local.get $0)` (= local 0 番 = first param、 stack に push、 そ の ま ま return)

## 新 出 keyword と 任 意 命 名 (= Step 1.1 と の 差 分)

Step 1.1 と 重 複 す る token (= `module`, `type`, `func`, `result`, `export`, `i32`) は 省 略、 新 出 の み:

| token                   | 種 別                              | 説 明                                                                             |
| ----------------------- | ---------------------------------- | --------------------------------------------------------------------------------- |
| `param`                 | WASM keyword (= 不 変)             | function の parameter declare 内 keyword                                          |
| `local.get`             | WASM instruction (= 不 変)         | local (= param + local var 共 通 indexing) を 引 い て stack に push す る opcode |
| `$0` (= function 内 の) | **任 意 (= binaryen 自 動 採 番)** | local id、 param が 0 番 目 か ら 採 番 + そ の 後 local var が 続 く             |

**注 意**: function 内 の `$0` は Step 1.1 の type-id `$0` と は **別 物**:

- type-id `$0` = **module-scope** = type table の 番 号
- local-id `$0` = **function-scope** = function 内 の param + local var の 番 号

同 じ 表 記 `$0` で **別 scope の 別 概 念** = 偶 然 一 致 し て い る だ け。

## WASM の local model (= 重 要)

`local.get` の 対 象 = **local index space** (= function-scope):

```
index 0..N-1 = parameters (= declare 順 に 採 番)
index N..M-1 = local variables (= (local ...) declare、 後 で 出 る)
```

step 1.2 = param 1 個 + local 0 個 = index 0 だ け 有 効、 `local.get 0` = first param を 引 く。

つ ま り **parameter と local variable は WASM 上 で 同 一 namespace (= local index)** を 共 有、 declare 順 番 で index が 採 番。 source-level で 「param か local か」 を 区 別 し て 書 く が、 instruction 上 は 同 じ `local.get` で 引 く。

## binaryen API ↔ `.wat` 対 応

```typescript
mod.addFunction(
  "passthrough",
  binaryen.i32, // param types = i32 (= 1 個)
  binaryen.i32, // result type
  [], // local types = ナ シ
  mod.local.get(0, binaryen.i32), // body = local.get 0
);
```

| build.ts                                          | .wat 出 力                                                            |
| ------------------------------------------------- | --------------------------------------------------------------------- |
| `addFunction(name, binaryen.i32, ...)` 第 2 引 数 | type section + func section の param declare に 反 映 = `(param i32)` |
| `mod.local.get(0, binaryen.i32)`                  | func body = `(local.get $0)`                                          |

`mod.local.get(index, type)` の 2 引 数:

- 第 1 = local index (= 0 番 目 = first param)
- 第 2 = local の 型 (= binaryen が 内 部 で type check 用 に 使 う、 WASM binary 上 で の type info は type section の signature 経 由 で 引 か れ る が、 binaryen API は 各 hit で 独 立 type 引 数 を 取 る design)

多 数 param case (= step 1.3 以 降 ま た は 別 step) で param types を 複 数 型 で declare する 場 合 は `binaryen.createType([binaryen.i32, binaryen.f32])` の よ う に array → type id を 作 っ て 渡 す path。 1 param scalar は 直 接 `binaryen.i32` 渡 し で OK。

## host JS が WASM を 呼 ぶ 経 路 (= `run.ts`)

```typescript
const { instance } = await WebAssembly.instantiate(wasm);
const passthrough = instance.exports.passthrough as (x: number) => number;
console.log(passthrough(7)); // → 7
```

- 引 数 型 = TS で `(x: number) => number` と annotate (= WASM の i32 は JS で number)
- WASM の `instance.exports.passthrough` 自 体 の TS 型 = `Function` ま た は `unknown` に な る 場 合 が あ る = explicit `as` cast で signature を 明 示 す る path が 慣 例

### JS ↔ WASM の scalar marshalling

JS engine が **自 動 で** 型 変 換 す る:

- **JS number → WASM i32**: 32-bit signed integer に truncate (= 小 数 切 り 捨 て + overflow は wraparound)。 例: `passthrough(7.9)` → 内 部 で 7 に truncate さ れ て 7 return
- **WASM i32 → JS number**: 32-bit signed integer と し て JS number に lift (= 正 確、 -2^31〜2^31-1 範 囲)

f32 / f64 marshalling は 別 軸 (= step 1.3 で 確 認)。

## 学 習 axes (= こ の step で 把 握 す る 概 念)

1. **`param` declare 構 文**: function の parameter は `(param <id> <type>)` 形 で declare、 多 数 declare 可。
2. **`local.get` instruction**: local index を 引 い て stack に push。 param を function 内 で 引 く 唯 一 path。
3. **local index space (= function-scope)**: parameter 0..N-1 + local variable N..M-1 が **同 一 namespace** を 共 有。
4. **JS ↔ WASM scalar marshalling**: JS number → WASM i32 (= truncate)、 WASM i32 → JS number (= signed lift)。 step 1.3 で f32 marshalling と 比 較。
5. **type-id vs local-id の `$0` 区 別**: module-scope の type-id `$0` と function-scope の local-id `$0` は **別 scope の 別 概 念**、 表 記 偶 然 一 致。

## 実 行 手 順

```sh
vp exec tsx step-1.2/build.ts   # → expected.wat + passthrough.wasm 出 力
vp exec tsx step-1.2/run.ts     # → passthrough(7) = 7 確 認
```

## Deliverable

- `build.ts` = binaryen で IR 構 築 + `.wat` / `.wasm` emit
- `run.ts` = `passthrough.wasm` を instantiate し て `passthrough(7) = 7` 確 認
- `expected.wat` = `build.ts` 出 力 snapshot、 commit 済 = regression 防 止
- `passthrough.wasm` = binary artifact、 `.gitignore` 対 象 = `build.ts` で 再 生 成 可
