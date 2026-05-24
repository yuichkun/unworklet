# Step 1.4 — Linear memory 宣 言 + f32.load 単 独

## このコードが やる こと (= big picture)

`build.ts` を 走 ら せ る と、 「linear memory を 1 page 宣 言 + export し、 引 数 ナ シ で memory address 0 か ら f32 を 1 個 load し て return す る `readGain` function」 を WASM で 構 築 + emit。

`run.ts` で:

1. `instance.exports.memory` を 取 得 → `new Float32Array(memory.buffer)` で typed view 作 成
2. host JS が `view[0] = 0.5` で memory address 0 に f32 値 0.5 を 書 込
3. `instance.exports.readGain()` を 呼 び 出 し て WASM が 同 location を `f32.load` で 読 む
4. return 値 が `0.5` で あ る こ と を assert

つ ま り = **host JS と WASM が 同 一 ArrayBuffer を 共 有 し、 host が 書 い た 値 を WASM が 読 む** path の 最 小 試 行。 arithmetic は ナ シ (= step 1.5 で 拡 張)、 「memory が 共 有 さ れ て い る」 path 単 独 を 把 握 す る の が 目 的。

unworklet 文 脈 で の 雛 形 = `param.at(0)` の **k-rate / length-1 marshalling**: main thread が AudioParam 値 を memory に 書 き 込 み、 worklet WASM が memory.load で 引 く path。 こ の step で 単 純 化 し た 最 小 形 を 押 さ え る。

## emit さ れ る `.wat`

```wat
(module
 (type $0 (func (result f32)))
 (memory $0 1 1)
 (export "memory" (memory $0))
 (export "readGain" (func $readGain))
 (func $readGain (result f32)
  (f32.load
   (i32.const 0)
  )
 )
)
```

Step 1.3 か ら の 変 更:

- L3 `(memory $0 1 1)` = memory section = 1 page initial + 1 page maximum の linear memory を 宣 言、 内 部 id = `$0`
- L4 `(export "memory" (memory $0))` = memory を export 名 `"memory"` で 露 出 (= host JS か ら 引 け る)
- L6-9 func body = `(f32.load (i32.const 0))` = i32.const 0 を address (= ptr) と し て f32.load (= memory か ら f32 を 1 個 読 む)

## 行 ご と

- **L1 `(module ...)`** = root node
- **L2 `(type $0 (func (result f32)))`** = type section (= 引 数 ナ シ + result f32)
- **L3 `(memory $0 1 1)`** = memory section = 1 page initial + 1 page max、 内 部 id `$0`
- **L4 `(export "memory" (memory $0))`** = memory export
- **L5 `(export "readGain" (func $readGain))`** = function export
- **L6-9 `(func $readGain (result f32) (f32.load (i32.const 0)))`** = func section:
  - body = `(f32.load (i32.const 0))` = address `i32.const 0` を pop し て f32.load で 4 bytes 読 む、 結 果 stack に push
  - 実 行 順 = (1) `i32.const 0` で 0 push → (2) `f32.load` で 0 pop + memory[0..3] 読 む + f32 push → function 終 了 で stack top = return

## 新 出 keyword と 任 意 命 名

| token | 種 別 | 説 明 |
|---|---|---|
| `memory` (= section) | WASM keyword (= 不 変) | linear memory section declare 内 keyword |
| `memory` (= export 名) | **任 意 (= user 命 名)** | `mod.setMemory(..., "memory")` 第 3 引 数 = host JS が `instance.exports.memory` で 引 く 名 |
| `f32.load` | WASM instruction (= 不 変) | memory か ら f32 を 1 個 (= 4 bytes) 読 ん で stack に push |
| `i32.const` | WASM instruction (= 不 変 = Step 1.1 出 出) | i32 immediate を stack に push (= こ こ で は memory address と し て 使 う) |
| `$0` (= memory id) | **任 意 (= binaryen 自 動 採 番)** | memory 内 部 id、 1 module 内 で 多 数 memory 持 て る 場 合 に 採 番 (= v1.0 spec で は 1 memory limit、 multi-memory proposal で 拡 張) |

`$0` が **3 種 類 出 る** こ と に 注 意:

- type-id `$0` (= module-scope、 type table) = Step 1.1 か ら 出 て い る
- local-id `$0` (= function-scope、 local index) = Step 1.2 か ら 出 て い る (= 但 し こ の step で は param ナ シ で 出 な い)
- memory-id `$0` (= module-scope、 memory index) = Step 1.4 新 出

全 て binaryen 自 動 採 番、 同 表 記 で 別 scope の 別 概 念。

## WASM linear memory model (= 新 出、 重 要)

WASM の **linear memory** = byte-addressable な 1 次 元 array = host JS の `ArrayBuffer` と 同 一 backing store を 共 有。

### 単 位 = page

- **1 page = 64 KB (= 65536 bytes = 16384 個 の f32)**
- memory section で `(memory N M)` 形 で declare = initial = N pages、 maximum = M pages
- step 1.4 = N=1, M=1 = fixed 1 page (= 64 KB) で grow 不 可

### address space

- byte-addressable = 0 番 か ら 64KB-1 番 ま で の byte address
- f32 1 個 = 4 bytes = address 0..3 / 4..7 / 8..11 / ...

### host JS と WASM の memory 共 有

```
WASM linear memory       host JS 側
─────────────────       ───────────────
                         instance.exports.memory  ← WebAssembly.Memory object
   byte 0..3   ← → →    memory.buffer            ← 同 一 ArrayBuffer
   byte 4..7              ↓ view creation
   byte 8..11             new Float32Array(memory.buffer)
   ...                       ↓
                          view[0] = f32 at byte 0..3
                          view[1] = f32 at byte 4..7
                          view[2] = f32 at byte 8..11
                          ...
```

- `instance.exports.memory` = `WebAssembly.Memory` object
- `memory.buffer` = 同 一 ArrayBuffer (= WASM linear memory と JS が 直 接 共 有、 copy ナ シ)
- `new Float32Array(memory.buffer)` = ArrayBuffer 全 体 を f32 array と し て 見 る typed view
- `view[0]` = byte 0..3 の f32 = WASM の `i32.const 0` + `f32.load` で 同 location を 読 む

### endianness

- WASM は **little-endian fixed** (= spec 規 定)
- JS の `Float32Array` は **host endianness** に 依 存 (= 但 し 主 要 platform = x86 / arm64 は little-endian = 実 質 同 一)
- 「同 byte pattern で 読 め る」 = WASM ↔ JS で 数 値 が 一 致

### byte offset vs element offset

- WASM の memory address = **byte offset** = `i32.const 0` = byte 0、 `i32.const 4` = byte 4 = f32 で は 2 個 目
- JS の `Float32Array view` = **element offset** = `view[0]` = byte 0..3、 `view[1]` = byte 4..7
- 「view[i] = WASM の i32.const (i * 4)」 の 関 係

## `f32.load` の signature

```
f32.load offset align ptr
       └─u32┘ └─u32┘ └─i32 expression┘
```

- **`ptr`** = i32 expression = address の base (= stack か ら pop)
- **`offset`** = u32 immediate = address に **静 的 加 算** さ れ る byte offset (= compile time constant)
- **`align`** = u32 immediate = alignment hint = `log2(byte alignment)` ま た は 直 接 byte alignment (= binaryen API は 直 接 byte 値 受 け 取 る、 4 = 4-byte align = f32 標 準)

実 際 の load address = `ptr + offset`。 align は **CPU 最 適 化 hint で あ り 実 行 動 作 に 影 響 し な い** (= mis-align で も 動 く が 遅 い 可 能 性)。 f32 標 準 align = 4。

step 1.4 で = ptr = `i32.const 0`、 offset = 0、 align = 4 = address = 0 + 0 = byte 0 か ら f32 load。

## binaryen API ↔ `.wat` 対 応

```typescript
mod.setMemory(1, 1, "memory");
mod.addFunction(
  "readGain",
  binaryen.none,
  binaryen.f32,
  [],
  mod.f32.load(
    0,                 // offset
    4,                 // align
    mod.i32.const(0),  // ptr expression
  ),
);
mod.addFunctionExport("readGain", "readGain");
```

| build.ts | .wat 出 力 |
|---|---|
| `mod.setMemory(1, 1, "memory")` | `(memory $0 1 1)` + `(export "memory" (memory $0))` |
| `mod.f32.load(offset, align, ptr)` | `(f32.load <ptr-emit>)` (= offset / align が 0 / default な ら text 省 略) |
| `mod.i32.const(0)` | `(i32.const 0)` |

注: `mod.f32.load(0, 4, ...)` の offset = 0 + align = 4 (= f32 default) = WAT text 上 で 省 略 さ れ る (= binaryen の emit が compact 形 を 選 ぶ)。 binary 上 で は 必 ず emit さ れ る が text 表 示 で は default 省 略 慣 例。

非 default 値 (= 例: offset=8) は `(f32.load offset=8 align=4 ptr-emit)` の よ う に text に 出 る。

## host JS が WASM を 呼 ぶ 経 路 (= `run.ts`)

```typescript
const { instance } = await WebAssembly.instantiate(wasm);
const memory = instance.exports.memory as WebAssembly.Memory;
const view = new Float32Array(memory.buffer);
view[0] = 0.5;
const readGain = instance.exports.readGain as () => number;
console.log(readGain()); // → 0.5
```

- `instance.exports.memory` = `WebAssembly.Memory` (= JS type、 lib.dom.d.ts 経 由)
- `memory.buffer` = `ArrayBuffer` (= 64 KB)
- `new Float32Array(buffer)` = typed view、 buffer と 同 一 backing store
- `view[0] = 0.5` = byte 0..3 に f32 値 0.5 を 書 込 (= host endianness で encode、 主 要 platform で little-endian = WASM と 同 一)
- `readGain()` = WASM が `f32.load(ptr=0)` で 同 byte 0..3 を 読 ん で 0.5 return

## 学 習 axes (= こ の step で 把 握 す る 概 念)

1. **memory section + export**: WASM module 内 で linear memory を 1 page declare、 host JS か ら 引 け る 名 で export。
2. **linear memory model**: byte-addressable / 1 page = 64KB / little-endian fixed / host JS と ArrayBuffer 共 有。
3. **WebAssembly.Memory + ArrayBuffer + typed view**: host JS が `memory.buffer` を `new Float32Array(...)` で view 化 = WASM と 同 一 backing store で 直 接 共 有。
4. **`f32.load(offset, align, ptr)` の 構 造**: ptr = i32 expression (= stack か ら)、 offset = static immediate、 align = CPU hint。 load address = ptr + offset。
5. **byte offset vs element offset**: WASM `i32.const N` = byte address N、 JS `view[i]` = byte address i*4 (= f32 case)。 同 location を 引 く 時 の 対 応。
6. **memory-id `$0` ↔ type-id `$0` ↔ local-id `$0` の 区 別**: 3 種 類 と も 別 scope の 別 概 念、 同 表 記 偶 然 一 致。

## 実 行 手 順

```sh
vp exec tsx step-1.4/build.ts   # → expected.wat + memload.wasm 出 力
vp exec tsx step-1.4/run.ts     # → view[0] = 0.5 + readGain() = 0.5 確 認
```

## Deliverable

- `build.ts` = binaryen で memory + readGain function を IR 構 築 + emit
- `run.ts` = host JS で view[0] 書 込 + WASM 経 由 で 読 出 確 認
- `expected.wat` = `build.ts` 出 力 snapshot、 commit 済
- `memload.wasm` = binary artifact、 `.gitignore` 対 象
