# Step 1.7 — forSample loop 相 当 (= loop + memory I/O 組 合 せ)

## このコードが やる こと (= big picture、 Phase 1 最 終 形)

`build.ts` を 走 ら せ る と、 「linear memory 上 に input array (= offset 0 か ら 128 個 の f32) と output array (= offset 512 か ら 128 個 の f32) を 配 置 し、 loop で `output[i] = input[i] * 0.5` を 128 sample 分 計 算 す る `process` function」 を WASM で 構 築 + emit。

`run.ts` で:

1. inputView[0..127] に 全 1.0 を 書 込
2. WASM `process()` 実 行
3. outputView[0..127] が 全 て 0.5 (= 1.0 × 0.5) で あ る こ と を assert

つ ま り = **Step 1.6 (= bounded loop 単 独) + Step 1.5 (= memory + arithmetic) を 組 合 せ た Phase 1 最 終 形**。 input region と output region を 別 offset で 共 存 + loop 内 で 動 的 address (= base + i\*4) を 計 算 + memory load / store。

**unworklet forSample 雛 形 完 結**:

```typescript
// unworklet DSL 記 述
forSample((i) => {
  output
    .ch(0)
    .at(i)
    .write(input.ch(0).at(i).mul(num(0.5)));
});

// compile 後 形 (= step 1.7 の WASM と 同 path):
//   for (i = 0; i < 128; i++) {
//     output_addr  = output_base + i * 4
//     input_value  = memory[input_base + i * 4]
//     output_value = input_value * 0.5
//     memory[output_addr] = output_value
//   }
```

= こ の step で 後 続 Phase 3 vertical slice (= stereo gain meter cut 版) の compile 後 形 の **base 完 結**、 後 続 phase は こ の path を `@unworklet/core` 内 部 module に 移 植 す る 形 で 拡 張。

## emit さ れ る `.wat` (= 期 待 形 の 主 軸)

```wat
(module
 (type $0 (func))
 (memory $0 1 1)
 (export "memory" (memory $0))
 (export "process" (func $process))
 (func $process
  (local $0 i32)
  (local.set $0 (i32.const 0))
  (block $break
   (loop $continue
    (br_if $break
     (i32.ge_s (local.get $0) (i32.const 128))
    )
    (f32.store
     ;; ptr = 512 + i*4
     (i32.add
      (i32.mul (local.get $0) (i32.const 4))
      (i32.const 512)
     )
     ;; value = memory[i*4] * 0.5
     (f32.mul
      (f32.load
       (i32.mul (local.get $0) (i32.const 4))
      )
      (f32.const 0.5)
     )
    )
    (local.set $0
     (i32.add (local.get $0) (i32.const 1))
    )
    (br $continue)
   )
  )
 )
)
```

(= 実 際 の binaryen emit 形 と は 微 差 (= multi-line 配 置 や 中 間 block) が 出 る 場 合 あ り、 `expected.wat` 自 動 生 成 で 確 定 形 確 認)

## linear memory の byte layout (= 新 出、 重 要)

step 1.4 / 1.5 で は memory address 0 (= 単 一 f32 = gain) だ け だ っ た。 step 1.7 で は memory を **複 数 sub-region に 分 割 し て 使 う**:

```
byte offset  | 内 容
─────────────┼──────────────────────────────
   0..3      | input[0]   (f32)
   4..7      | input[1]   (f32)
   ...       | ...
 508..511    | input[127] (f32)
─────────────┼──────────────────────────────
 512..515    | output[0]  (f32)
 516..519    | output[1]  (f32)
 ...         | ...
1020..1023   | output[127] (f32)
─────────────┼──────────────────────────────
1024..       | (= 未 使 用、 64KB - 1024 = 残 り 63 KB)
```

= input region と output region を **同 一 memory 内 で 連 続 配 置**、 別 typed view で 引 く:

```typescript
const inputView = new Float32Array(memory.buffer, 0, 128); // byte 0..511
const outputView = new Float32Array(memory.buffer, 512, 128); // byte 512..1023
```

`Float32Array(buffer, byteOffset, length)` = buffer の 指 定 offset か ら length 個 の f32 view (= byte offset + element length)。

これ が unworklet の linear memory layout (= state slots + buffer + I/O scratch + ringbuffer 等 の sub-region 配 置) の 最 小 形。 各 sub-region を offset で 区 切 り、 base + index\*size で access。

## 動 的 address 計 算 = `base + i * size`

step 1.4 / 1.5 で は address = `i32.const 0` (= 固 定)、 step 1.7 で は loop counter `i` に 応 じ て address が 変 わ る:

- input address = `i * 4` (= base 0 + i \* f32 size 4)
- output address = `512 + i * 4` (= base 512 + i \* f32 size 4)

WASM で の 計 算 expression:

```wat
;; input[i] address
(i32.mul (local.get $0) (i32.const 4))

;; output[i] address
(i32.add
 (i32.mul (local.get $0) (i32.const 4))
 (i32.const 512))
```

= `i32.mul` + `i32.add` で address を expression と し て build、 `f32.load` / `f32.store` の ptr 引 数 に 渡 す。

## stack 評 価 順 (= f32.store の 2 operand)

`f32.store ptr value` の stack 動 作:

```
[実 行 前 ]            stack: [        ]
<ptr-emit>     →     stack: [ ptr    ]
<value-emit>   →     stack: [ ptr val ]
f32.store      →     stack: [        ]   ; 2 個 pop + memory に write
```

= step 1.6 の i32.store と 同 形、 type が f32 に な っ た だ け。 binaryen API `mod.f32.store(offset, align, ptr, value)` = 4 引 数 で WAT の `(f32.store ptr value)` を 出 力。

## 新 出 軸 (= Step 1.6 と の 差 分)

新 keyword は ナ シ (= 既 出 の 組 合 せ)。 新 軸:

- **linear memory の sub-region 分 割** = input + output を 別 offset で 共 存、 別 typed view で 引 く
- **動 的 address 計 算** = `base + i * size` を i32 arithmetic で 組 み 立 て、 ptr 引 数 に 渡 す
- **loop body 内 で memory load + arithmetic + memory store** を 1 hit に combine = unworklet forSample の core path
- **`Float32Array(buffer, byteOffset, length)` の 3 引 数 form** = ArrayBuffer 全 体 で は な く partial view を 切 り 出 す

## binaryen API ↔ `.wat` 対 応 (= 差 分 だ け)

step 1.6 + step 1.5 と 同 pattern。 新 出:

| build.ts                          | .wat 出 力                  |
| --------------------------------- | --------------------------- |
| `mod.f32.store(0, 4, ptr, value)` | `(f32.store <ptr> <value>)` |
| `mod.i32.mul(a, b)`               | `(i32.mul <a> <b>)`         |

## host JS が WASM を 呼 ぶ 経 路 (= `run.ts`)

```typescript
const memory = instance.exports.memory as WebAssembly.Memory;
const inputView = new Float32Array(memory.buffer, 0, 128); // input region
const outputView = new Float32Array(memory.buffer, 512, 128); // output region

for (let i = 0; i < 128; i++) inputView[i] = 1.0;

const process = instance.exports.process as () => void;
process();

// outputView[0..127] が 全 て 0.5 で あ る こ と を assert
```

`Float32Array(buffer, byteOffset, length)` = buffer の 指 定 byte offset か ら length 個 の f32 を 引 く partial view。 同 ArrayBuffer を 複 数 view で 別 region と し て 引 く 慣 用 path。

## unworklet 文 脈 で の 完 結 性 (= Phase 1 終 結)

step 1.7 で **Phase 1 全 7 step が 揃 う**:

- step 1.1 = WASM 基 礎 (= module / func / export / instantiate)
- step 1.2 = param + local.get (= function 引 数)
- step 1.3 = f32 + binary op (= stack machine の core)
- step 1.4 = linear memory + load (= host ↔ WASM 共 有)
- step 1.5 = memory + arithmetic 組 合 せ (= unworklet param.at(0) 雛 形)
- step 1.6 = bounded loop (= structured control flow)
- step 1.7 = loop + memory I/O (= unworklet forSample 雛 形 = Phase 1 最 終)

後 続:

- Phase 2 = monorepo 4 package skeleton + 公 開 surface declare (= 実 装 ナ シ stub)
- Phase 3 = Phase 1 で 把 握 し た WASM emit path を `@unworklet/core` 内 部 compile module に 移 植 + `renderOffline` で driver = canonical Ex 1 (= stereo gain meter cut 版) を end-to-end 動 作

## 学 習 axes (= こ の step で 把 握 す る 概 念)

1. **linear memory の sub-region 分 割**: 1 つ の memory 内 に input / output 等 別 region を offset で 区 切 っ て 配 置、 各 region は base + index\*size で address。
2. **動 的 address 計 算**: `i32.mul` + `i32.add` で address expression を build、 `f32.load` / `f32.store` の ptr 引 数 に 渡 す。
3. **loop body 内 で memory load + arithmetic + memory store**: step 1.5 の 1 sample 計 算 を loop で 128 回 反 復 = unworklet forSample callback の compile 後 形。
4. **`Float32Array(buffer, byteOffset, length)` の 3 引 数 form**: partial view = ArrayBuffer 全 体 で は な く 指 定 region だ け を 引 く path。
5. **Phase 1 全 体 の 統 合**: step 1.1〜1.7 で 把 握 し た 全 概 念 が こ の 1 function に 統 合 = WASM emit pipeline の 基 礎 完 結。

## 実 行 手 順

```sh
vp exec tsx step-1.7/build.ts   # → expected.wat + process.wasm 出 力
vp exec tsx step-1.7/run.ts     # → output[0..127] = 0.5 確 認
```

## Deliverable

- `build.ts` = binaryen で process function を IR 構 築 + emit
- `run.ts` = host JS で input 書 込 + WASM 実 行 + output 全 sample 確 認
- `expected.wat` = `build.ts` 出 力 snapshot
- `process.wasm` = binary artifact
