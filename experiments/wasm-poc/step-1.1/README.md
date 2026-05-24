# Step 1.1 — Minimum WASM (constant return)

## このコードが やる こと (= big picture)

`build.ts` を 走 ら せ る と:

1. `binaryen` (= WASM toolkit JS package) を 使 っ て、 「`main` と い う 名 前 の function を 1 つ 持 ち、 中 身 は 数 字 42 を return す る だ け」 の **最 小 WASM module** を IR (= 中 間 表 現) 上 で 構 築
2. その IR を 2 つ の 形 で emit:
   - **`.wat` (= WebAssembly Text format)** = 人 間 が 読 め る text 形 (= S-expression base)
   - **`.wasm` (= WASM binary)** = browser / Node の `WebAssembly.instantiate()` が 食 う bytes

`run.ts` を 走 ら せ る と、 emit さ れ た `.wasm` を Node の `WebAssembly.instantiate()` で load し、 export さ れ た `main` function を JS か ら 呼 び 出 し、 return 値 が 42 で あ る こ と を assert。

つ ま り = **「JS → binaryen で WASM 構 築 → emit → JS で 実 行」 path が 1 通 り 通 る** こ と を 確 認 す る **最 小 試 行**。 WASM の 中 身 (= 42 を return す る だ け) は 学 習 用 で あ り、 後 続 step で だ ん だ ん 複 雑 化 (= 引 数 → 計 算 → memory → loop) し て い く。

## WebAssembly Text format (= `.wat`) と は

WASM binary (= `.wasm`) は bytes の 並 び = 人 間 に 読 め な い。 WAT (= WebAssembly Text format) = 同 内 容 を **S-expression 形 式** で 人 間 が 読 め る よ う に 表 現 し た テ キ ス ト 形 式。

WAT の 構 文:

- `(...)` で nest = LISP 系 の S-expression
- `(` 直 後 の 単 語 = **node 種 別 keyword** (= WASM spec で 規 定 さ れ た 不 変 token)
- 後 続 = 引 数 / 子 node

例: `(i32.const 42)` = 「`i32.const` と い う 種 別 の node、 immediate value `42`」 = WASM 1 instruction を 表 す。

## emit さ れ た `.wat` (= 6 行)

```wat
(module
 (type $0 (func (result i32)))
 (export "main" (func $main))
 (func $main (result i32)
  (i32.const 42)
 )
)
```

行 ご と:

- **L1 `(module ...)`** = WASM 全 体 を 包 む root node。 module 内 に function / type / export / memory 等 全 declare が 入 る。
- **L2 `(type $0 (func (result i32)))`** = **type section** = function 1 個 分 の signature を declare = 「引 数 ナ シ + result i32 1 個」、 type-id `$0` で 採 番。
- **L3 `(export "main" (func $main))`** = **export section** = host JS か ら 引 け る 名 前 declare = export 名 `"main"`、 中 身 = `$main` と い う internal function ref。
- **L4-6 `(func $main (result i32) (i32.const 42))`** = **func section** = function 本 体 declare:
  - internal 名 = `$main`
  - result type = `i32`
  - body = `(i32.const 42)` (= 1 instruction)

## 組 み 込 み keyword vs 任 意 命 名 (= ど こ ま で が WASM spec、 ど こ か ら が user 自 由 か)

| token       | 種 別                              | 説 明                                                                                                              |
| ----------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `module`    | WASM keyword (= 不 変)             | root node 名、 spec 規 定                                                                                          |
| `type`      | WASM keyword (= 不 変)             | type section node 名                                                                                               |
| `func`      | WASM keyword (= 不 変)             | function node 名                                                                                                   |
| `result`    | WASM keyword (= 不 変)             | function の result type を 示 す 名                                                                                |
| `export`    | WASM keyword (= 不 変)             | export section node 名                                                                                             |
| `i32`       | WASM 型 keyword (= 不 変)          | 32-bit signed integer 型                                                                                           |
| `i32.const` | WASM instruction (= 不 変)         | i32 immediate value を operand stack に push す る opcode                                                          |
| `$0`        | **任 意 (= binaryen 自 動 採 番)** | type index name、 `$` prefix で source-level 名 を 示 す symbol。 0 文 字 列 は 単 に 0 番 目 の 採 番 結 果       |
| `$main`     | **任 意 (= user 命 名)**           | function internal name。 `build.ts` の `mod.addFunction("main", ...)` 第 1 引 数 = `"main"` を `$` prefix で 表 示 |
| `"main"`    | **任 意 (= user 命 名)**           | export name。 `build.ts` の `mod.addFunctionExport("main", "main")` 第 2 引 数                                     |
| `42`        | **任 意 (= user 数 値)**           | immediate value、 `build.ts` の `mod.i32.const(42)` 引 数                                                          |

**注 意**:

- **internal 名 `$main`** と **export 名 `"main"`** が 同 じ 文 字 列 で あ る の は **偶 然**。 別 文 字 列 で も OK (= 例: `addFunction("foo", ...)` + `addFunctionExport("foo", "bar")` で internal `$foo` を `"bar"` で export)。
- **`$0`** も binaryen 自 動 採 番 で 偶 然 文 字 列 `"0"` が 入 っ た だ け。

## binaryen API ↔ `.wat` の 対 応

`build.ts` の binaryen API hit と emit さ れ る `.wat` の 対 応:

| build.ts                                                                      | .wat 出 力                                                                                                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `new binaryen.Module()`                                                       | `(module ...)` root node 開 始                                                                                                        |
| `mod.addFunction("main", binaryen.none, binaryen.i32, [], mod.i32.const(42))` | type section `(type $0 (func (result i32)))` を **自 動 で** 添 加 + func section `(func $main (result i32) (i32.const 42))` を 添 加 |
| `mod.addFunctionExport("main", "main")`                                       | export section `(export "main" (func $main))` を 添 加                                                                                |
| `mod.emitText()`                                                              | 上 記 6 行 を text と し て return                                                                                                    |
| `mod.emitBinary()`                                                            | 同 内 容 を WASM binary bytes と し て return                                                                                         |

注: type section (= L2) は user が 明 示 declare し て い な い = `addFunction` の signature 引 数 (= `binaryen.none` + `binaryen.i32`) を 元 に **binaryen が 自 動 で** type を 採 番 + 添 加 し て く れ る。 user は signature を addFunction の 引 数 で 1 度 渡 す だ け、 type section と func section 両 方 に binaryen が 自 動 配 信。

## `$0` と `$main` の link は ど こ で 決 ま る か

`$0` (= L2 `(type $0 (func (result i32)))`) は **main を 指 し て い る の で は な い**。 `$0` = type section 内 の type entry の id = 「type table の 0 番 目 entry」、 中 身 は 「引 数 ナ シ + result i32 1 個」 と い う **signature 形** だ け。 main 自 体 は こ の type を 「使 う 側」、 `$0` 自 体 が main を 直 接 指 す 関 係 で は な い。

main ↔ type 0 の link は ど こ で 結 ば れ る か:

1. **WAT text 上 で は 表 示 さ れ て な い**: 上 記 emit 出 力 で は `(func $main (result i32) (i32.const 42))` 形 = signature を inline で 書 い て い る (= type ref が text に 出 な い)。
2. **WAT 文 法 上 は ref 明 示 形 も valid**: `(func $main (type $0) (result i32) (i32.const 42))` の よ う に 書 い て も 同 等。 binaryen は inline signature 形 を 選 ぶ design choice (= 可 読 性 重 視)。
3. **WASM binary spec 上 で は 必 ず link**: WASM binary の function section は 各 function entry に type index (= u32) を 持 つ = `$main` の bytecode に 「type table 0 番」 が encode さ れ て い る = link は binary 上 で 必 ず 存 在 す る。

つ ま り 「link は WAT 表 示 上 隠 れ て い る だ け、 binary 上 で は 必 ず 1 つ の type を 参 照」 と い う 関 係。

`build.ts` の ど こ で link が 決 ま る か:

```typescript
mod.addFunction(
  "main", // internal 名 (= $main)
  binaryen.none, // param types
  binaryen.i32, // result type
  [], // local types
  mod.i32.const(42), // body
);
```

第 2 引 数 `binaryen.none` (= param types) + 第 3 引 数 `binaryen.i32` (= result type) が 「signature 形」 を 決 定。 binaryen は 内 部 で:

1. 「同 形 signature が 既 type section に あ る か?」 を check
2. ナ シ な ら type 0 番 と し て **新 規 add** (= L2 `(type $0 ...)` が 自 動 出 力)
3. function `$main` の type index を **0 に 自 動 set** (= binary 上 で link 完 成)

= user は 5 引 数 を 1 hit で 渡 す だ け、 type section 採 番 と function ↔ type link 両 方 を binaryen が 自 動 で 処 理。

## な ぜ type section が 別 declare? (= WASM の 設 計 意 図)

WASM spec で signature を type section に 別 declare す る 理 由:

1. **複 数 function が 同 signature を 共 有** で き る = 1 個 の type entry を 多 数 function が 参 照 = binary size 削 減
2. **`call_indirect` (= indirect call、 後 続 step で 出 て く る) で signature check** に 使 う = function table 経 由 で 関 数 を 動 的 に 呼 ぶ 時、 受 け 取 る function が 期 待 signature か を runtime check す る た め の type 引 用

step 1.1 = function 1 個 + indirect call ナ シ = type section は 1 entry だ け。 た だ し WASM の **設 計 上 必 ず 存 在 す る** section と し て emit 出 力 に 出 る。

## host JS が WASM を 呼 ぶ 経 路 (= `run.ts`)

```typescript
const { instance } = await WebAssembly.instantiate(wasm);
const main = instance.exports.main as () => number;
console.log(main()); // → 42
```

- `WebAssembly.instantiate(wasm)` = WASM binary を browser / Node ランタイム に 渡 し て instance 作 成、 `{ instance, module }` を return
- `instance.exports.<export-name>` = WAT 内 `(export "main" ...)` で 露 出 し た 名 前 = JS function と し て 引 け る
- 型 = `() => number` (= 引 数 ナ シ、 i32 return = JS で は number)
- 呼 ぶ と 42 が return

binaryen は run side で 不 要 = 既 emit 済 binary を `WebAssembly.instantiate` で 読 む だ け = production runtime 経 路 と 同 形 (= 後 続 phase の `@unworklet/core` 公 開 compile API も build-time に binaryen で emit + runtime に は binary だ け を ship、 同 path で driver さ れ る)。

### `WebAssembly` global の 出 所

`WebAssembly.instantiate(wasm)` の `WebAssembly` = JS 言 語 環 境 の global object = **WebAssembly JavaScript Interface (= W3C 仕 様)** が 規 定 す る standard surface。 Node + browser の 両 環 境 が **runtime で 同 仕 様 を 実 装** = 「Node の 組 み 込 み」 と も 「browser 標 準」 と も 言 え る (= ど ち ら の 環 境 で も 動 く 同 一 仕 様)。

TypeScript の type declare 経 路 は **browser global declare 経 由**:

- `lib.dom.d.ts` (= browser global を declare) ま た は `lib.webworker.d.ts` で `WebAssembly` namespace が 露 出
- `@types/node` に は declare ナ シ (= grep 0 hit で 確 認、 Node-specific decl は 持 た ず browser global declare に 依 拠)
- Node 上 で 動 か す code で も `tsconfig.json` の `lib` に `dom` (= 既 採 用) or `webworker` 追 加 が 必 要 = browser global declare に link し て type を 引 く 形

つ ま り 「`WebAssembly` は ど こ の 組 み 込 み か?」 = 「JS 言 語 環 境 (= browser + Node) の standard global、 W3C 仕 様 が 規 定」 = browser-only で も Node-only で も な く、 両 方 が 同 仕 様 を 実 装 し て い る 形。

## 学 習 axes (= こ の step で 把 握 す る 概 念)

1. **`.wat` の S-expression 構 文**: `(keyword args...)` で nest、 keyword が node 種 別 を 示 す。
2. **module / type / func / export section の 役 割**: WASM module 内 部 構 造 の 4 軸。
3. **組 み 込 み keyword vs 任 意 命 名 の 区 別**: `module`, `func`, `i32` 等 = 不 変、 `$main`, `"main"`, `42` 等 = 任 意。
4. **WASM stack machine model**: 各 instruction が operand stack を pop / push、 function 終 了 時 の stack top が return value (= `i32.const 42` で 42 push、 そ の ま ま return)。
5. **binaryen API → `.wat` の 対 応**: `addFunction` の 5 引 数 (= internal 名 / param types / result type / local types / body) が type section + func section に **自 動 分 解** さ れる。
6. **JS ↔ WASM boundary**: `WebAssembly.instantiate(binary)` → `instance.exports.<name>(args)` で 呼 ぶ 最 小 path、 runtime は binary だ け で 動 く (= binaryen 不 要)。

## 実 行 手 順

```sh
vp exec tsx step-1.1/build.ts   # → expected.wat + main.wasm 出 力
vp exec tsx step-1.1/run.ts     # → main() = 42 確 認
```

## Deliverable

- `build.ts` = binaryen で IR 構 築 + `.wat` / `.wasm` emit
- `run.ts` = `main.wasm` を instantiate し て 42 確 認
- `expected.wat` = `build.ts` 出 力 snapshot、 commit 済 = regression 防 止
- `main.wasm` = binary artifact、 `.gitignore` 対 象 = `build.ts` で 再 生 成 可
