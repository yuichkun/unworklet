/**
 * `renderOffline` behavior (= `13-offline-render.md` §2)。 Step 3.6 で
 * fill。
 *
 * driver-friendly handle (= `result.driver.instantiate()` 越 し) で memory
 * I/O を 駆 動、 render quantum 単 位 で input / param marshal + process()
 * + output read を 反 復。 duration × sampleRate は SAMPLES_PER_BLOCK で
 * 切 り 上 げ (= `13-offline-render.md` §2.1)。
 */

import "@unworklet/core"; // side-effect load for `.mul` method registration via primitives.ts
import { defineProcessor, f32, i32, message, SAMPLES_PER_BLOCK, select } from "@unworklet/core";
import { audioInput, audioOutput, buffer, event, forSample, param, state } from "@unworklet/core";
import { expect, test } from "vite-plus/test";

import { renderOffline } from "./index.ts";

// ─────────────────────────────────────────────────────────────────────────
// typed-array message payload (Stage 2.5a) — message<{ samples: Float32Array }>
// を main から送り、worklet で samples.at(i) / samples.length で読む。
// ─────────────────────────────────────────────────────────────────────────

// 受信した配列を per-element に buffer へ書き写し、それを再生する (= .at(Node) runtime read)。
const samplePlayer = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const upload = message<{ samples: Float32Array }>({ name: "upload" });
  const buf = buffer.f32({ size: SAMPLES_PER_BLOCK });
  return {
    process: () => {
      upload.onReceive(({ samples }) => {
        forSample((i) => {
          buf.write(i, samples.at(i)); // i は Node<i32> = runtime indexed read
        });
      });
      forSample((i) => {
        out.ch(0).at(i).write(buf.read(i));
      });
    },
  };
});

test("`renderOffline` delivers a typed-array payload; samples.at(Node) reads each element", async () => {
  const samples = new Float32Array(SAMPLES_PER_BLOCK);
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) samples[k] = k * 2;
  const result = await renderOffline(samplePlayer, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
    messages: [{ name: "upload", payload: { samples } }],
  });
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) {
    expect(result.outputs.main![0]![k]).toBe(k * 2);
  }
});

// 受信した配列を buf.copyFrom で一括コピー (= memory.copy、per-sample loop の代替)。
const sampleCopier = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const upload = message<{ samples: Float32Array }>({ name: "upload" });
  const buf = buffer.f32({ size: SAMPLES_PER_BLOCK });
  return {
    process: () => {
      upload.onReceive(({ samples }) => {
        buf.copyFrom(samples); // 一括 bulk copy
      });
      forSample((i) => {
        out.ch(0).at(i).write(buf.read(i));
      });
    },
  };
});

test("`renderOffline` buf.copyFrom(payload) が配列を buffer に一括コピーする", async () => {
  const samples = new Float32Array(SAMPLES_PER_BLOCK);
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) samples[k] = k * 3;
  const result = await renderOffline(sampleCopier, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
    messages: [{ name: "upload", payload: { samples } }],
  });
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) {
    expect(result.outputs.main![0]![k]).toBe(k * 3);
  }
});

test("`renderOffline` buf.copyFrom は min(buf.size, payload length) で clamp する", async () => {
  // buf.size = 128、payload = 4 要素 → 先頭 4 要素だけ copy、残りは buffer 初期値 0。
  const samples = new Float32Array([1.5, 2.5, 3.5, 4.5]);
  const result = await renderOffline(sampleCopier, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
    messages: [{ name: "upload", payload: { samples } }],
  });
  expect(result.outputs.main![0]![0]).toBe(1.5);
  expect(result.outputs.main![0]![3]).toBe(4.5);
  expect(result.outputs.main![0]![4]).toBe(0); // payload 長を超えた領域は未変更
});

// samples.at の範囲外読み (= idx outside [0, length)) は §4.3 の select carrier-clamp で
// runtime trap せず [0, length-1] に丸められる。far OOB を読んで last element が返ることを確認。
const oobReader = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const upload = message<{ samples: Float32Array }>({ name: "upload" });
  const oobState = state.f32(0);
  return {
    process: () => {
      upload.onReceive(({ samples }) => {
        oobState.store(samples.at(100000)); // far OOB read
      });
      forSample((i) => {
        out.ch(0).at(i).write(oobState.load());
      });
    },
  };
});

test("`renderOffline` samples.at の範囲外読みは trap せず [0,length-1] に clamp する", async () => {
  const result = await renderOffline(oobReader, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
    messages: [{ name: "upload", payload: { samples: new Float32Array([10, 20, 30, 40]) } }],
  });
  // idx 100000 は length 4 を超える → clamp で last element 40、trap なし。
  expect(result.outputs.main![0]![0]).toBe(40);
});

// 同一 quantum に複数の typed-array message を queue しても content が上書きされず
// 各 payload が保持される (§5.2 / Q85: content = perPayload × min(capacity, 16) 枠)。
// handler は drain loop で per-slot 走る → 各 slot の samples.at(0) を state に加算。
const twoUploads = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const upload = message<{ samples: Float32Array }>({ name: "upload" });
  const acc = state.f32(0);
  return {
    process: () => {
      upload.onReceive(({ samples }) => {
        acc.store(acc.load().add(samples.at(0)));
      });
      forSample((i) => {
        out.ch(0).at(i).write(acc.load());
      });
    },
  };
});

test("`renderOffline` 同一 quantum の 2 message が content 上書きされず両方保持される", async () => {
  const result = await renderOffline(twoUploads, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
    messages: [
      { name: "upload", atQuantum: 0, payload: { samples: new Float32Array([10, 0, 0, 0]) } },
      { name: "upload", atQuantum: 0, payload: { samples: new Float32Array([20, 0, 0, 0]) } },
    ],
  });
  // 両 payload 保持 = 10 + 20 = 30。単一 chunk 上書き bug なら 20 + 20 = 40。
  expect(result.outputs.main![0]![0]).toBeCloseTo(30, 4);
});

test("`renderOffline` content 枠 (16) を超える連射でも trap せず render 完走する (Q85: drop-oldest)", () => {
  // 1 quantum に 17 message を queue = 17 個目が最古の chunk を循環再利用で上書き。
  // クラッシュ (trap / OOB) しないこと + 結果が有限値であることだけ担保。
  const messages = Array.from({ length: 17 }, (_, k) => ({
    name: "upload",
    atQuantum: 0,
    payload: { samples: new Float32Array([k + 1, 0, 0, 0]) },
  }));
  return renderOffline(twoUploads, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
    messages,
  }).then((result) => {
    expect(Number.isFinite(result.outputs.main![0]![0])).toBe(true);
  });
});

// samples.length = 受信した配列長 (= Node<i32>)。出力にそのまま流して観測。
const sampleLen = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const upload = message<{ samples: Float32Array }>({ name: "upload" });
  const lenState = state.i32(0);
  return {
    process: () => {
      upload.onReceive(({ samples }) => {
        lenState.store(samples.length);
      });
      forSample((i) => {
        out.ch(0).at(i).write(f32(lenState.load()));
      });
    },
  };
});

test("`renderOffline` resolves samples.length to the delivered payload length", async () => {
  const result = await renderOffline(sampleLen, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
    messages: [{ name: "upload", payload: { samples: new Float32Array(10) } }],
  });
  expect(result.outputs.main![0]![0]).toBe(10);
});

// 空 payload (length 0) の .at(idx) は stale memory でなく 0 を返す (= §4.3、no-trap +
// OOB/empty は 0)。content chunk を再利用させて leak を観測する: block 0 で 16 個の
// 非空 message [42] を流して全 16 chunk を [42] で埋め、block 1 で空 message を head=16
// = chunk 0 に wrap landing させる (= cross-block なので drop-oldest overflow も踏まない)。
// stale read だと length-1=-1 で clamp が idx 0 に潰れ、chunk 0 の [42] を読んでしまう。
const emptyPayloadReader = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const upload = message<{ x: Float32Array }>({ name: "upload" });
  const last = state.f32(-1);
  return {
    process: () => {
      upload.onReceive(({ x }) => {
        last.store(x.at(0));
      });
      forSample((i) => {
        out.ch(0).at(i).write(last.load());
      });
    },
  };
});

test("`renderOffline` 空 payload の .at(0) は stale memory でなく 0 を返す (§4.3)", async () => {
  const fill42 = Array.from({ length: 16 }, () => ({
    name: "upload",
    atQuantum: 0,
    payload: { x: new Float32Array([42]) },
  }));
  const result = await renderOffline(emptyPayloadReader, {
    sampleRate: 48000,
    duration: (2 * SAMPLES_PER_BLOCK) / 48000,
    messages: [
      ...fill42,
      { name: "upload", atQuantum: 1, payload: { x: new Float32Array([]) } }, // 空 = chunk 0 に wrap
    ],
  });
  // block 0 = 非空 [42] の処理結果 (= 経路 sanity)。
  expect(result.outputs.main![0]![0]).toBe(42);
  // block 1 = 空 payload。stale read なら chunk 0 の [42] が leak、fix 後は 0。
  expect(result.outputs.main![0]![SAMPLES_PER_BLOCK]).toBe(0);
});

// message<T> 経由で state を更新する processor (= scalar message 注入の検証用)。
// 出力はそのまま mul state の値 (= 注入が届けば block ごとに値が変わる)。
const messageMul = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const setMul = message<{ mul: number }>({ name: "setMul" });
  const mulState = state.i32(1);
  return {
    process: () => {
      setMul.onReceive(({ mul }) => {
        mulState.store(mul);
      });
      forSample((i) => {
        out.ch(0).at(i).write(f32(mulState.load()));
      });
    },
  };
});

test("`renderOffline` delivers a scheduled scalar message to the worklet handler", async () => {
  const result = await renderOffline(messageMul, {
    sampleRate: 48000,
    duration: (2 * SAMPLES_PER_BLOCK) / 48000,
    messages: [
      { name: "setMul", payload: { mul: 3 }, atQuantum: 0 },
      { name: "setMul", payload: { mul: 7 }, atQuantum: 1 },
    ],
  });
  const ch = result.outputs.main![0]!;
  // quantum 0 で mul=3、quantum 1 で mul=7 が handler 経由で state に反映される。
  expect(ch[0]).toBe(3);
  expect(ch[SAMPLES_PER_BLOCK]).toBe(7);
});

test("`renderOffline` defaults message delivery to quantum 0 when atQuantum is omitted", async () => {
  const result = await renderOffline(messageMul, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
    messages: [{ name: "setMul", payload: { mul: 5 } }],
  });
  expect(result.outputs.main![0]![0]).toBe(5);
});

// boolean-valued message field (= Q46 で 現状 i32 wire に lift される)。
const messageFlag = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const setOn = message<{ on: boolean }>({ name: "setOn" });
  const flag = state.bool(false);
  return {
    process: () => {
      setOn.onReceive(({ on }) => {
        flag.store(on);
      });
      forSample((i) => {
        out
          .ch(0)
          .at(i)
          .write(select(flag.load(), f32(1), f32(0)));
      });
    },
  };
});

test("`renderOffline` delivers a boolean-valued message field (true then false)", async () => {
  const result = await renderOffline(messageFlag, {
    sampleRate: 48000,
    duration: (2 * SAMPLES_PER_BLOCK) / 48000,
    messages: [
      { name: "setOn", payload: { on: true }, atQuantum: 0 },
      { name: "setOn", payload: { on: false }, atQuantum: 1 },
    ],
  });
  const ch = result.outputs.main![0]!;
  expect(ch[0]).toBe(1); // quantum 0: on=true
  expect(ch[SAMPLES_PER_BLOCK]).toBe(0); // quantum 1: on=false
});

test("`renderOffline` throws on a message whose name has no matching declaration", async () => {
  await expect(
    renderOffline(messageMul, {
      sampleRate: 48000,
      duration: SAMPLES_PER_BLOCK / 48000,
      messages: [{ name: "ghost", payload: {} }],
    }),
  ).rejects.toThrow(/no matching message/);
});

const stereoGain = defineProcessor(() => {
  const input = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });
  const gain = param.f32({ default: 1, min: 0, max: 4, automationRate: "a-rate" }).named("gain");
  return {
    process: () => {
      forSample((i) => {
        out.left.at(i).write(input.left.at(i).mul(gain.at(i)));
        out.right.at(i).write(input.right.at(i).mul(gain.at(i)));
      });
    },
  };
});

const oneBlockInput = (value: number): Float32Array => {
  const data = new Float32Array(SAMPLES_PER_BLOCK);
  data.fill(value);
  return data;
};

test("`renderOffline` returns the result shape (= outputs / events / state)", async () => {
  const result = await renderOffline(stereoGain, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
    inputs: { main: [oneBlockInput(1), oneBlockInput(0.25)] },
    params: { gain: [0.5] },
  });
  expect(result).toEqual({
    outputs: { main: [oneBlockInput(0.5), oneBlockInput(0.125)] },
    events: [],
    state: new Uint8Array(0),
    sampleRate: 48000,
  });
});

test("`renderOffline` reproduces input × gain on each sample (= 1 block)", async () => {
  const inputCh0 = new Float32Array(SAMPLES_PER_BLOCK);
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) inputCh0[i] = i / SAMPLES_PER_BLOCK;
  const inputCh1 = oneBlockInput(0);
  const result = await renderOffline(stereoGain, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
    inputs: { main: [inputCh0, inputCh1] },
    params: { gain: [2] }, // k-rate broadcast
  });
  const expectedCh0 = new Float32Array(SAMPLES_PER_BLOCK);
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) expectedCh0[i] = (i / SAMPLES_PER_BLOCK) * 2;
  expect(result).toEqual({
    outputs: { main: [expectedCh0, oneBlockInput(0)] },
    events: [],
    state: new Uint8Array(0),
    sampleRate: 48000,
  });
});

test("`renderOffline` runs multiple blocks (= duration = 2 × SAMPLES_PER_BLOCK / sampleRate)", async () => {
  const totalSamples = SAMPLES_PER_BLOCK * 2;
  const inputCh = new Float32Array(totalSamples);
  inputCh.fill(1);
  const expectedCh = new Float32Array(totalSamples);
  expectedCh.fill(0.5);
  const result = await renderOffline(stereoGain, {
    sampleRate: 48000,
    duration: totalSamples / 48000,
    inputs: { main: [inputCh, inputCh] },
    params: { gain: [0.5] },
  });
  expect(result).toEqual({
    outputs: { main: [expectedCh, expectedCh] },
    events: [],
    state: new Uint8Array(0),
    sampleRate: 48000,
  });
});

test("`renderOffline` rounds up duration × sampleRate to the next SAMPLES_PER_BLOCK boundary", async () => {
  // 48 sample 分 要 求 (= 0.001 sec @ 48kHz) = 1 block (= 128 sample) に 切 り 上 げ
  const result = await renderOffline(stereoGain, {
    sampleRate: 48000,
    duration: 48 / 48000,
    inputs: { main: [oneBlockInput(1), oneBlockInput(1)] },
    params: { gain: [0.5] },
  });
  expect(result.outputs["main"]![0]!.length).toBe(SAMPLES_PER_BLOCK);
  expect(result.outputs["main"]![1]!.length).toBe(SAMPLES_PER_BLOCK);
});

test("`renderOffline` uses param default when `params[name]` is omitted (= length 0 normalize)", async () => {
  const result = await renderOffline(stereoGain, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
    inputs: { main: [oneBlockInput(1), oneBlockInput(1)] },
  });
  // gain default = 1 = passthrough
  expect(result.outputs).toEqual({
    main: [oneBlockInput(1), oneBlockInput(1)],
  });
});

test("`renderOffline` fills zero when `inputs[name]` is omitted", async () => {
  const result = await renderOffline(stereoGain, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
    params: { gain: [1] },
  });
  expect(result.outputs).toEqual({
    main: [oneBlockInput(0), oneBlockInput(0)],
  });
});

test("`renderOffline` zero-pads input channel when input array is shorter than the render", async () => {
  // 64 sample 分 だ け input 渡 す + duration = 128 sample = 後 半 64 sample
  // は 0 fill = output 後 半 64 sample も 0 で 出 る。
  const shortInput = new Float32Array(64);
  shortInput.fill(1);
  const result = await renderOffline(stereoGain, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
    inputs: { main: [shortInput, shortInput] },
    params: { gain: [0.5] },
  });
  const expectedCh = new Float32Array(SAMPLES_PER_BLOCK);
  for (let i = 0; i < 64; i++) expectedCh[i] = 0.5;
  // 64 以 降 = 0 (= input zero pad × gain = 0)
  expect(result.outputs).toEqual({ main: [expectedCh, expectedCh] });
});

test("`renderOffline` holds the last param sample when param array is shorter than the render", async () => {
  // gain = [0.25, 0.75] の 2 sample = 1 < length < SAMPLES_PER_BLOCK
  // = sample 0 → 0.25、 sample 1 → 0.75、 sample 2..127 → 0.75 (= last hold)。
  const inputCh = oneBlockInput(1);
  const result = await renderOffline(stereoGain, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
    inputs: { main: [inputCh, inputCh] },
    params: { gain: [0.25, 0.75] },
  });
  const expectedCh = new Float32Array(SAMPLES_PER_BLOCK);
  expectedCh[0] = 0.25;
  for (let i = 1; i < SAMPLES_PER_BLOCK; i++) expectedCh[i] = 0.75;
  expect(result.outputs).toEqual({ main: [expectedCh, expectedCh] });
});

test("`renderOffline` per-sample param array (= length 128 a-rate) is applied per-sample", async () => {
  const inputCh = oneBlockInput(1);
  const gainData = new Float32Array(SAMPLES_PER_BLOCK);
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) gainData[i] = i / SAMPLES_PER_BLOCK;
  const result = await renderOffline(stereoGain, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
    inputs: { main: [inputCh, inputCh] },
    params: { gain: Array.from(gainData) },
  });
  const expectedCh = new Float32Array(SAMPLES_PER_BLOCK);
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) expectedCh[i] = gainData[i]!;
  expect(result.outputs).toEqual({ main: [expectedCh, expectedCh] });
});

// ─────────────────────────────────────────────────────────────────────────
// state plain factory integration = Phase 7 sub-phase 7.1 完 了 条 件
// (= declarative path で state.f32(0) + load/store + WASM emit が render
// quantum 跨 い で 反 映)。
// ─────────────────────────────────────────────────────────────────────────

test("`renderOffline` preserves state across render quanta (= literal store cross-block)", async () => {
  // state slot に literal 0.6 を store → 次 block で load し て output。 cross-block
  // で state 値 が 持続 することを確認 (= 1 instance を 全 block で 駆 動 = state
  // memory が render quantum 跨 い で 維 持)。 input 経 由 + subnormal guard の
  // interaction で 出 力 が NaN に な る 経 路 は 別 issue (= 重 複 emit の binaryen
  // 内部 path 想 定) = sub-phase 7.x で 解 析 + fix 予 定、 sub-phase 7.1 完 了
  // 条 件 は literal store path で 担 保。
  const stateSet = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const stored = state.f32(0);
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(stored.load());
        });
        // 全 block 末 尾 で literal 0.6 を store (= subnormal range 外 = guard 通 過)
        stored.store(0.6);
      },
    };
  });

  const result = await renderOffline(stateSet, {
    sampleRate: 48000,
    duration: (2 * SAMPLES_PER_BLOCK) / 48000,
  });
  const ch = result.outputs["main"]![0]!;
  // block 1 (= sample 0..127): stored 初 期 値 = WASM memory 0 = output 0
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) {
    expect(ch[i]).toBe(0);
  }
  // block 2 (= sample 128..255): block 1 末 尾 で store し た 0.6 を load = output 0.6
  for (let i = SAMPLES_PER_BLOCK; i < 2 * SAMPLES_PER_BLOCK; i++) {
    expect(ch[i]).toBeCloseTo(0.6, 6);
  }
});

test("`renderOffline` state f32 chained mul across blocks (= counter × 0.5 decay)", async () => {
  // canonical Ex 1 per-block meter decay path を simplify (= counter を 全 block 末 尾 で
  // 0.5 倍)。 state instance が 全 block で 共 有 + load × mul → store が cross-block
  // で 動 く こ と を 確 認。 memory zero-init で 起 動 = counter 0 → store(0 × 0.5) = 0
  // = 全 block 全 sample 0 (= declaration initial 値 を memory に inject する path は
  // sub-phase 7.x で fill)。
  const stateDecay = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const counter = state.f32(1);
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(counter.load());
        });
        counter.store(counter.load().mul(0.5));
      },
    };
  });

  const totalBlocks = 3;
  const result = await renderOffline(stateDecay, {
    sampleRate: 48000,
    duration: (totalBlocks * SAMPLES_PER_BLOCK) / 48000,
  });
  const ch = result.outputs["main"]![0]!;
  for (let i = 0; i < totalBlocks * SAMPLES_PER_BLOCK; i++) {
    expect(ch[i]).toBe(0);
  }
});

test("`renderOffline` state declaration が driver から 除 外 さ れ る (= regression: state slot を param と 誤 認 し て writeParam で NaN 上書 き さ れ な い)", async () => {
  // root cause regression: makeDriver の declarations map で state declaration が
  // 「else 分 岐 = param」 と し て 誤 認 さ れ て いた path = renderOffline で
  // writeParam("__state_<idx>", paramScratch.fill(undefined)) が state slot を
  // NaN で 上 書 き し て いた。 fix 後 = state は driver declarations か ら 除 外、
  // renderOffline は state slot に 触 ら ない (= WASM 内 で 完 結)。
  const accumulator = defineProcessor(() => {
    const input = audioInput({ channels: 1, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    const stored = state.f32(0);
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(stored.load());
        });
        stored.store(input.ch(0).at(0).mul(2));
      },
    };
  });
  const inputData = new Float32Array(2 * SAMPLES_PER_BLOCK);
  inputData.fill(0.3);
  const result = await renderOffline(accumulator, {
    sampleRate: 48000,
    duration: (2 * SAMPLES_PER_BLOCK) / 48000,
    inputs: { main: [inputData] },
  });
  const ch = result.outputs["main"]![0]!;
  // block 1 で stateLoad = 0.6 (= NaN な し)、 block 0 末 尾 の store 値 が 持 続
  expect(Number.isNaN(ch[SAMPLES_PER_BLOCK]!)).toBe(false);
  expect(ch[SAMPLES_PER_BLOCK]).toBeCloseTo(0.6, 6);
});

test("`renderOffline` state f32 cross-block via input-driven store + load (= 累 積 path)", async () => {
  // input × 2 を state に store → 次 block で load し て output に 流 す。 cross-block
  // で state 値 が 持 続 + audioInRead 経 由 + forSample 外 store path で NaN な し =
  // subnormal guard の if-else lazy evaluation refactor で fix 済 (= 789da18 commit)。
  const accumulator = defineProcessor(() => {
    const input = audioInput({ channels: 1, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    const stored = state.f32(0);
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(stored.load());
        });
        stored.store(input.ch(0).at(0).mul(2));
      },
    };
  });

  // input block 1 = 0.3 全 sample、 block 2 = 0.7 全 sample
  const inputData = new Float32Array(2 * SAMPLES_PER_BLOCK);
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) inputData[i] = 0.3;
  for (let i = SAMPLES_PER_BLOCK; i < 2 * SAMPLES_PER_BLOCK; i++) inputData[i] = 0.7;

  const result = await renderOffline(accumulator, {
    sampleRate: 48000,
    duration: (2 * SAMPLES_PER_BLOCK) / 48000,
    inputs: { main: [inputData] },
  });
  const ch = result.outputs["main"]![0]!;

  // block 1 (= sample 0..127): stored 初 期 値 = WASM memory 0 = output 0
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) {
    expect(ch[i]).toBe(0);
  }
  // block 2 (= sample 128..255): block 1 末 尾 で 0.3 × 2 = 0.6 を store = output 0.6
  for (let i = SAMPLES_PER_BLOCK; i < 2 * SAMPLES_PER_BLOCK; i++) {
    expect(ch[i]).toBeCloseTo(0.6, 6);
  }
});

test("`renderOffline` publish scheduler integration (= rateFps gate で sampleRate option が反 映)", async () => {
  // canonical Ex 1 meter L pattern simplify: input.ch(0).at(0) を per-block store + publish 30fps。
  // sampleRate 48000 / rateFps 30 = threshold 1600、 13 block (= 1664 sample) で 1 度 due。
  // renderOffline は publishShared / Counters を 外 に 出 さ な い (= sub-phase 7.4 / 7.5 で main
  // surface 経 由 で 取 得 す る path)、 ただ こ こ で は compile を 直 接 呼 ん で driver.instantiate
  // 経 由 で memory を 直 視 + sub-phase 7.3 で hand し た sampleRate が compile + emit を 通 っ て
  // threshold const fold に 反 映 さ れ た か を 確 認。
  const meterProc = defineProcessor(() => {
    const input = audioInput({ channels: 1, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    const meter = state.f32(0).expose({ name: "meter", publish: { rateFps: 30 } });
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(input.ch(0).at(i));
        });
        meter.store(input.ch(0).at(0));
      },
    };
  });

  const { compile: coreCompile } = await import("@unworklet/core");
  const compiled = await coreCompile(meterProc, { sampleRate: 48000 });
  const instance = await compiled.driver.instantiate();
  // compiled.memory は MemoryJson brand 経 由 = 内 部 layout shape へ cast (= test path 限 定)
  const lay = compiled.memory as unknown as {
    regions: {
      publishShared: { slots: Record<string, number> };
      publishCounters: { slots: Record<string, number> };
    };
  };
  const inputBlock = new Float32Array(SAMPLES_PER_BLOCK);
  inputBlock.fill(0.7);
  for (let b = 0; b < 13; b++) {
    instance.writeInput("main", 0, inputBlock);
    instance.process();
  }
  const sharedView = new Float32Array(
    instance.memory.buffer,
    lay.regions.publishShared.slots["meter"]!,
    1,
  );
  const counterView = new Int32Array(
    instance.memory.buffer,
    lay.regions.publishCounters.slots["meter"]!,
    2,
  );
  // 13 block 目 で 1 度 due = version 1、 counter 64、 sharedView に 0.7 copy
  expect(counterView[1]).toBe(1);
  expect(counterView[0]).toBe(64);
  expect(sharedView[0]).toBeCloseTo(Math.fround(0.7), 6);
});

test("`renderOffline` で sampleRate option が compile 経 由 で emit に 反 映 (= 同 graph 別 sampleRate で threshold 別 値)", async () => {
  // 同 processor を sampleRate 48000 と 96000 で compile = threshold 1600 と 3200。
  // renderOffline 自 体 は config.sampleRate を compile に hand す る path = 同 processor
  // で 別 sampleRate render = 別 due block 数 = sampleRate hand path 担 保。
  const meterProc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const meter = state.f32(0).expose({ name: "meter", publish: { rateFps: 30 } });
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(meter.load());
        });
        meter.store(0.5);
      },
    };
  });

  // block 0 = forSample で meter.load() = 0 (= 初 期 値) を 全 sample に write、 末 尾 で
  // meter.store(0.5)。 block 1 以 降 = forSample で 0.5 を 全 sample に write。
  // publish 自 体 は SAB / main surface を 通 し て 観 測 で きな い (= sub-phase 7.4 / 7.5)、
  // ここ で は state 本 体 の cross-block 動 作 + sampleRate option が compile を 通 過 す る
  // path を 確 認 (= compile fail し な い + 出 力 path 維 持)。
  const r48 = await renderOffline(meterProc, {
    sampleRate: 48000,
    duration: (2 * SAMPLES_PER_BLOCK) / 48000,
  });
  // block 0 = 0、 block 1 = 0.5 (= state 本 体 path 担 保、 publish path と は 独 立)
  expect(r48.outputs["main"]![0]![0]).toBe(0);
  expect(r48.outputs["main"]![0]![SAMPLES_PER_BLOCK]).toBeCloseTo(Math.fround(0.5), 6);

  // 同 graph で sampleRate 96000 に 変 え て も compile 成 功 + 出 力 path 維 持
  const r96 = await renderOffline(meterProc, {
    sampleRate: 96000,
    duration: (2 * SAMPLES_PER_BLOCK) / 96000,
  });
  expect(r96.outputs["main"]![0]![SAMPLES_PER_BLOCK]).toBeCloseTo(Math.fround(0.5), 6);
});

test("`renderOffline` subnormal flush integration (= state.f32 store 1e-40 → 0)", async () => {
  // store し た 1e-40 が WASM emit の subnormal guard で 0 に flush さ れ、 次 block
  // で load し た 時 そ の ま ま 0 = output 全 0。 end-to-end で Q21 subnormal flush が
  // declarative path で 効 い て い る こ と を 確 認 (= audioInRead 経 由 + forSample 外
  // store path で NaN 経 由 せ ず flush 動 作、 if-else lazy refactor 後 担 保)。
  const subnormalProc = defineProcessor(() => {
    const input = audioInput({ channels: 1, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    const z = state.f32(0);
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(z.load());
        });
        z.store(input.ch(0).at(0).mul(1e-40));
      },
    };
  });

  const result = await renderOffline(subnormalProc, {
    sampleRate: 48000,
    duration: (2 * SAMPLES_PER_BLOCK) / 48000,
    // input = 1 全 sample = store 値 = 1 × 1e-40 = subnormal = guard で 0 flush
    inputs: { main: [oneBlockInput(1)] },
  });
  const ch = result.outputs["main"]![0]!;
  // block 1 / 2 全 sample = 0 (= subnormal flush で z が 0 のまま)
  for (let i = 0; i < 2 * SAMPLES_PER_BLOCK; i++) {
    expect(ch[i]).toBe(0);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// events real capture (= sub-phase 7.8c)。 worklet → main の event ring を
// renderOffline が WASM memory から walk + OfflineEmittedEvent 配 列 で 返 す。
// ─────────────────────────────────────────────────────────────────────────

test("`renderOffline` captures emitted events from event ring (= sub-phase 7.8c)", async () => {
  const eventProc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "out" });
    const peakEvt = event<{ level: number }>({ name: "peak", capacity: 16 });
    // gate state を true 固 定 + stateLoad cond で Q32-c constant-truthy 回 避
    const gate = state.named("gate").bool(true);
    return {
      process: () => {
        gate.store(true);
        forSample((i) => {
          peakEvt.emitIf(gate.load(), { atSample: i, level: 0.5 });
          out.ch(0).at(i).write(0);
        });
      },
    };
  });
  const result = await renderOffline(eventProc, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000, // 1 block = 128 emit、 capacity 16 で 112 drop
  });
  expect(result.events.length).toBeGreaterThan(0);
  // 全 event の name = "peak"、 atSample は 0..127 範 囲、 level = 0.5
  for (const evt of result.events) {
    expect(evt.name).toBe("peak");
    expect(evt.atSample).toBeGreaterThanOrEqual(0);
    expect(evt.atSample).toBeLessThan(SAMPLES_PER_BLOCK);
    expect((evt.payload as { level: number }).level).toBe(0.5);
  }
});

// worklet → main の typed-array event payload (§4.3 L708)。worklet 内 buffer に書いて
// emitIf に buffer + framework-injected length を渡すと、main 側は length 長の fresh
// Float32Array を受け取る。
test("`renderOffline` captures a typed-array event payload as a Float32Array", async () => {
  const arrayEmitter = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const buf = buffer.f32({ size: 4 });
    const result = event<{ data: Float32Array }>({ name: "result", payloadCapacity: 64 });
    return {
      process: () => {
        for (let k = 0; k < 4; k++) buf.write(k, f32((k + 1) * 11));
        result.emitIf(true, { atSample: 0, data: buf, length: i32(4) });
        forSample((i) => {
          out.ch(0).at(i).write(f32(0));
        });
      },
    };
  });
  const result = await renderOffline(arrayEmitter, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
  });
  expect(result.events.length).toBe(1);
  const ev = result.events[0]!;
  expect(ev.name).toBe("result");
  expect(Array.from((ev.payload as { data: Float32Array }).data)).toEqual([11, 22, 33, 44]);
});

// emitIf の length が buffer サイズを超えても、copy byte 数は buffer 境界に clamp される
// (= さもないと memory.copy が buffer.<T> 領域を超えて隣接 linear memory を読み、その
// バイトを main に publish する = memory disclosure)。length 1024 を size 4 buffer で emit
// → drained payload は buffer の 4 要素に clamp される。
test("`renderOffline` typed-array event は length が buffer 超でも buffer 境界に clamp (= leak 防止)", async () => {
  const overEmitter = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const buf = buffer.f32({ size: 4 });
    const result = event<{ data: Float32Array }>({ name: "result", payloadCapacity: 64 });
    return {
      process: () => {
        for (let k = 0; k < 4; k++) buf.write(k, f32((k + 1) * 11));
        result.emitIf(true, { atSample: 0, data: buf, length: i32(1024) }); // buffer(4) 超の length
        forSample((i) => {
          out.ch(0).at(i).write(f32(0));
        });
      },
    };
  });
  const result = await renderOffline(overEmitter, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
  });
  expect(result.events.length).toBe(1);
  const data = (result.events[0]!.payload as { data: Float32Array }).data;
  // length は buffer の 4 要素に clamp = 隣接 memory を leak しない。
  expect(data.length).toBe(4);
  expect(Array.from(data)).toEqual([11, 22, 33, 44]);
});

test("`renderOffline` captures bool wireType event field as JS boolean", async () => {
  const boolEvtProc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "out" });
    const flagEvt = event<{ flag: boolean }>({ name: "flag", capacity: 16 });
    const gate = state.named("gate").bool(true);
    return {
      process: () => {
        gate.store(true);
        forSample((i) => {
          flagEvt.emitIf(gate.load(), { atSample: i, flag: true });
          out.ch(0).at(i).write(0);
        });
      },
    };
  });
  const result = await renderOffline(boolEvtProc, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
  });
  expect(result.events.length).toBeGreaterThan(0);
  expect((result.events[0]!.payload as { flag: boolean }).flag).toBe(true);
});

test("`renderOffline` returns empty events when no event declarations exist", async () => {
  const result = await renderOffline(stereoGain, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
    inputs: { main: [new Float32Array(SAMPLES_PER_BLOCK), new Float32Array(SAMPLES_PER_BLOCK)] },
  });
  expect(result.events).toEqual([]);
});
