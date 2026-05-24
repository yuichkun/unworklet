# Step 1.5 — Memory load + arithmetic (= runtime gain 適 用)

## このコードが やる こと (= big picture)

`build.ts` を 走 ら せ る と、 「引 数 1 個 (= f32 = sample) を 受 け 取 り、 memory address 0 か ら 別 の f32 (= gain) を load し、 2 つ を 掛 け た 結 果 を return す る `applyGain` function」 を WASM で 構 築 + emit。

`run.ts` で:

1. `view[0] = 0.5` で gain 値 を 書 込
2. `applyGain(2.0)` で WASM が `2.0 × memory[0] = 2.0 × 0.5 = 1.0` を 計 算
3. return 値 が `1.0` で あ る こ と を assert

つ ま り = **Step 1.4 (= memory load 単 独) を arithmetic と 組 合 せ た 形**。 step 1.3 の f32.mul + step 1.4 の memory + step 1.2 の param 全 部 を 1 hit に zip。

**unworklet 文 脈 で の 雛 形 完 成**: audio sample × runtime param = `param.at(0)` (= k-rate / length-1 marshalling) の compile 後 形 の **完 全 な 最 小 形**。 main thread が AudioParam 値 を memory に 書 き、 worklet WASM が memory.load + f32.mul で audio sample に 掛 け る path = unworklet の 主 要 audio DSP path の 雛 形。

## emit さ れ る `.wat`

```wat
(module
 (type $0 (func (param f32) (result f32)))
 (memory $0 1 1)
 (export "memory" (memory $0))
 (export "applyGain" (func $applyGain))
 (func $applyGain (param $0 f32) (result f32)
  (f32.mul
   (local.get $0)
   (f32.load
    (i32.const 0)
   )
  )
 )
)
```

Step 1.4 か ら の 変 更:

- L2 type = `(func (param f32) (result f32))` (= sample 引 数 + result)
- L6-12 func body = `(f32.mul (local.get $0) (f32.load (i32.const 0)))` = step 1.3 の 形 + step 1.4 の f32.load を 第 2 operand に nest

## 行 ご と + stack 評 価 順

func body の **3 行 nest**:

```wat
(f32.mul
 (local.get $0)         ; 子 1
 (f32.load              ; 子 2 (= さ ら に nest)
  (i32.const 0)
 )
)
```

stack 評 価 順 (= `applyGain(2.0)` 呼 び 出 し 時、 view[0]=0.5):

```
[実 行 前 ]                stack: [        ]
local.get $0       →     stack: [ 2.0    ]              ; param 0 (= sample) を push
i32.const 0        →     stack: [ 2.0 0  ]              ; address を push
f32.load           →     stack: [ 2.0 0.5 ]             ; address pop + memory[0..3] 読 ん で push
f32.mul            →     stack: [ 1.0    ] (= 2.0 × 0.5); 2 個 pop + 乗 算 + push
(= function 終 了)        return = stack top = 1.0
```

つ ま り **WASM の S-expression `(f32.mul A B)` は A → B → mul の 順 に evaluate**:

- A = `(local.get $0)` = 1 instruction で stack に 1 個 push
- B = `(f32.load (i32.const 0))` = 2 instruction = `i32.const 0` push + `f32.load` で pop+push = 結 局 stack に 1 個 push
- `f32.mul` = 2 個 pop + 1 個 push

= 「子 expression を 全 部 評 価 し て stack に operand を 揃 え て か ら 親 op が consume」 path。 nest し て も stack 動 作 は **1 直 線**。

## 新 出 軸 (= Step 1.4 と の 差 分)

新 keyword ナ シ (= 既 出 を 組 合 せ)。 新 軸:

- **S-expression nest が 深 く な る** = `(f32.mul opA (f32.load (i32.const 0)))` の よ う に op の operand が さ ら に op = stack 機 械 で は 順 次 評 価 で operand を 揃 え て か ら op で consume
- **memory + param + arithmetic を 1 function に combine** = step 1.4 の memload を 「runtime gain と し て 引 く」 use case に 拡 張、 unworklet `param.at(0)` 雛 形 完 結

## binaryen API ↔ `.wat` 対 応

```typescript
mod.f32.mul(
  mod.local.get(0, binaryen.f32), // operand 1
  mod.f32.load(0, 4, mod.i32.const(0)), // operand 2 (= nested)
);
```

| build.ts                         | .wat 出 力                        |
| -------------------------------- | --------------------------------- |
| `mod.f32.mul(opA, opB)`          | `(f32.mul <opA-emit> <opB-emit>)` |
| `mod.local.get(0, binaryen.f32)` | `(local.get $0)`                  |
| `mod.f32.load(0, 4, ptr)`        | `(f32.load <ptr-emit>)`           |

binaryen の expression tree は **JS code 上 で 直 接 nest で 組 み 立 て る** = 後 続 phase で 複 雑 な expression (= 例: `mod.f32.add(mod.f32.mul(a, b), c)`) を 同 pattern で 拡 張 で きる。

## host JS が WASM を 呼 ぶ 経 路 (= `run.ts`)

```typescript
const { instance } = await WebAssembly.instantiate(wasm);
const memory = instance.exports.memory as WebAssembly.Memory;
const view = new Float32Array(memory.buffer);
view[0] = 0.5; // gain を 書 込
const applyGain = instance.exports.applyGain as (s: number) => number;
console.log(applyGain(2.0)); // → 1.0
```

- step 1.4 の memory view 操 作 + step 1.3 の WASM function 呼 び 出 し を 1 hit に combine
- host が gain 値 を 動 的 に 変 更 可 能 = `view[0] = 1.5; applyGain(2.0)` → `3.0` 等

## unworklet 文 脈 で の 完 結 性

step 1.5 = unworklet で の 「audio sample × param」 の **compile 後 形 の 雛 形 完 結**:

- **main thread** = AudioParam 値 を memory の 規 定 offset (= 例 = param section base + name 対 応 offset) に 書 込 (= `audioWorkletNode.parameters['gain'].value = 0.5` の 内 部 動 作)
- **worklet WASM** = forSample callback 内 で memory.load + f32.mul で sample に 掛 け る (= `output.ch(0).at(i).write(input.ch(0).at(i).mul(gain.at(0)))` の compile 後 形)

後 続 step (= 1.6 / 1.7) で **loop control flow + multi-sample I/O** を 追 加 し て forSample 全 体 の 雛 形 に 拡 張。

## 学 習 axes (= こ の step で 把 握 す る 概 念)

1. **S-expression の nest と stack 評 価 順**: `(f32.mul A B)` の A / B が さ ら に op で あ っ て も 順 次 評 価 で stack に operand を 揃 え る path、 nest が 深 く な っ て も stack 動 作 は 1 直 線。
2. **memory + param + arithmetic の 組 合 せ**: step 1.2 + 1.3 + 1.4 を combine し て unworklet の 主 要 path (= sample × runtime param) を 1 function に。
3. **runtime mutable param**: host JS が memory を 書 き 換 え る だ け で WASM 側 の 計 算 結 果 が 変 わ る = recompile ナ シ で 値 動 的 変 更 path = AudioParam 自 動 化 の 雛 形。
4. **binaryen expression tree の nest 構 築**: AST node を method 呼 び 出 し で 深 く nest = WASM S-expression と 1:1、 後 続 phase で 複 雑 な expression 表 現 可。

## 実 行 手 順

```sh
vp exec tsx step-1.5/build.ts   # → expected.wat + applygain.wasm 出 力
vp exec tsx step-1.5/run.ts     # → view[0] = 0.5 + applyGain(2.0) = 1.0 確 認
```

## Deliverable

- `build.ts` = binaryen で memory + applyGain function を IR 構 築 + emit
- `run.ts` = host JS で view[0] 書 込 + WASM 計 算 + 結 果 確 認
- `expected.wat` = `build.ts` 出 力 snapshot
- `applygain.wasm` = binary artifact
