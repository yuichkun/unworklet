# Step 1.1 — Minimum WASM (constant return)

## Goal

binaryen の Module / Function / Type API の 最 小 形 を 把 握。 WASM の `func` declaration + `export` + immediate const + JS instantiate flow を 1 通 り 経 由。

## WASM 構造

```wat
(module
  (func $main (export "main") (result i32)
    i32.const 42))
```

- 引 数 ナ シ
- result = i32 (= 32-bit signed integer を 1 個 return)
- body = `i32.const 42` (= 即 値 42 を operand stack に push、 function 終 了 時 の stack top が return value)

## binaryen API (= build.ts)

```typescript
mod.addFunction(
  "main", // internal 名
  binaryen.none, // parameter types (= ナ シ)
  binaryen.i32, // result type
  [], // local 変 数 types (= ナ シ)
  mod.i32.const(42), // body expression
);
mod.addFunctionExport("main", "main");
```

`mod.emitText()` で `.wat` (= text 表 現)、 `mod.emitBinary()` で `.wasm` binary。

## Host JS (= run.ts)

```typescript
const { instance } = await WebAssembly.instantiate(wasm);
const main = instance.exports.main as () => number;
console.log(main()); // → 42
```

binaryen は run side で 不 要 = 既 emit 済 binary を `WebAssembly.instantiate` で 読 む だ け = production runtime 経 路 と 同 形 (= 後 続 phase の `@unworklet/core` の 公 開 compile API も 同 path で driver さ れ る)。

## 学 習 軸

- **binaryen IR API** → WASM binary emit + .wat print。 `Module` / `addFunction` / `addFunctionExport` が 最 小 surface。
- **WASM の stack machine model**: function 内 で 各 instruction が operand stack を pop / push、 function 終 了 時 の stack top が return。 `i32.const 42` = 42 を stack に push、 そ の ま ま return。
- **JS ↔ WASM boundary**: `WebAssembly.instantiate(binary)` → `instance.exports.<name>(args)` で 呼 ぶ 最 小 path。

## 実 行

```sh
vp exec tsx step-1.1/build.ts   # → expected.wat + main.wasm 出 力
vp exec tsx step-1.1/run.ts     # → main() = 42 確 認
```

## Deliverable

- `build.ts` (= binaryen で IR 構 築 + .wat + .wasm emit)
- `run.ts` (= main.wasm を instantiate し て 42 確 認)
- `expected.wat` (= build.ts 出 力 snapshot、 commit 済 = regression 防 止)
- `main.wasm` (= binary artifact、 .gitignore 対 象 = build.ts で 再 生 成 可)
