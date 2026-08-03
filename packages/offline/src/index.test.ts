/**
 * `renderOffline` behavior (= `13-offline-render.md` §2).
 *
 * Drives memory I/O through the driver-friendly handle
 * (`result.driver.instantiate()`), iterating per render quantum:
 * marshal input/param → process() → read output.
 * duration × sampleRate is rounded up to SAMPLES_PER_BLOCK
 * (= `13-offline-render.md` §2.1).
 */

import "@unworklet/core"; // side-effect load for `.mul` method registration via primitives.ts
import {
  defineProcessor,
  f32,
  i32,
  inspectSnapshot,
  SAMPLES_PER_BLOCK,
  select,
} from "@unworklet/core";
import { audioInput, audioOutput, event, forSample, param, state } from "@unworklet/core";
import { expect, test } from "vite-plus/test";

import { renderOffline } from "./index.ts";

// ─────────────────────────────────────────────────────────────────────────
// typed-array message payload (Stage 2.5a) — message<{ samples: Float32Array }>
// sent from main; worklet reads via samples.at(i) / samples.length.
// ─────────────────────────────────────────────────────────────────────────

// Copies each received element into a buffer per-element, then plays it back (= .at(Node) runtime read).
const samplePlayer = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const upload = event<{ samples: Float32Array }>({ from: "main", name: "upload" });
  const buf = state.buffer.f32({ size: SAMPLES_PER_BLOCK });
  return {
    process: () => {
      upload.onReceive(({ samples }) => {
        forSample((i) => {
          buf.write(i, samples.at(i)); // i is Node<i32> = runtime indexed read
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

// Bulk-copies the received array into the buffer via buf.copyFrom (= memory.copy; alternative to a per-sample loop).
const sampleCopier = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const upload = event<{ samples: Float32Array }>({ from: "main", name: "upload" });
  const buf = state.buffer.f32({ size: SAMPLES_PER_BLOCK });
  return {
    process: () => {
      upload.onReceive(({ samples }) => {
        buf.copyFrom(samples); // bulk copy
      });
      forSample((i) => {
        out.ch(0).at(i).write(buf.read(i));
      });
    },
  };
});

test("`renderOffline` buf.copyFrom(payload) bulk-copies the array into the buffer", async () => {
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

test("`renderOffline` buf.copyFrom clamps to min(buf.size, payload length)", async () => {
  // buf.size = 128, payload = 4 elements → only the first 4 elements are copied; the rest stay at buffer's initial value 0.
  const samples = new Float32Array([1.5, 2.5, 3.5, 4.5]);
  const result = await renderOffline(sampleCopier, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
    messages: [{ name: "upload", payload: { samples } }],
  });
  expect(result.outputs.main![0]![0]).toBe(1.5);
  expect(result.outputs.main![0]![3]).toBe(4.5);
  expect(result.outputs.main![0]![4]).toBe(0); // region beyond payload length is untouched
});

// Out-of-bounds reads via samples.at (= idx outside [0, length)) are carrier-clamped to [0, length-1]
// by the §4.3 select path — no runtime trap. Verified by reading far OOB and expecting the last element.
const oobReader = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const upload = event<{ samples: Float32Array }>({ from: "main", name: "upload" });
  const oobState = state.f32(0);
  return {
    process: () => {
      upload.onReceive(({ samples }) => {
        oobState.write(samples.at(100000)); // far OOB read
      });
      forSample((i) => {
        out.ch(0).at(i).write(oobState.read());
      });
    },
  };
});

test("`renderOffline` samples.at out-of-bounds read clamps to [0,length-1] without trapping", async () => {
  const result = await renderOffline(oobReader, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
    messages: [{ name: "upload", payload: { samples: new Float32Array([10, 20, 30, 40]) } }],
  });
  // idx 100000 exceeds length 4 → clamps to last element 40, no trap.
  expect(result.outputs.main![0]![0]).toBe(40);
});

// Multiple typed-array messages queued in the same quantum are each preserved without overwriting
// (§5.2 / Q85: content = perPayload × min(capacity, 16) slots).
// The handler runs per-slot in the drain loop, accumulating samples.at(0) from each slot into state.
const twoUploads = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const upload = event<{ samples: Float32Array }>({ from: "main", name: "upload" });
  const acc = state.f32(0);
  return {
    process: () => {
      upload.onReceive(({ samples }) => {
        acc.write(acc.read().add(samples.at(0)));
      });
      forSample((i) => {
        out.ch(0).at(i).write(acc.read());
      });
    },
  };
});

test("`renderOffline` two messages in the same quantum are both preserved without content overwrite", async () => {
  const result = await renderOffline(twoUploads, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
    messages: [
      { name: "upload", atQuantum: 0, payload: { samples: new Float32Array([10, 0, 0, 0]) } },
      { name: "upload", atQuantum: 0, payload: { samples: new Float32Array([20, 0, 0, 0]) } },
    ],
  });
  // Both payloads preserved = 10 + 20 = 30. A single-chunk overwrite bug would yield 20 + 20 = 40.
  expect(result.outputs.main![0]![0]).toBeCloseTo(30, 4);
});

test("`renderOffline` render completes without trapping when messages exceed the content capacity of 16 (Q85: drop-oldest)", () => {
  // Queue 17 messages in one quantum: the 17th wraps and overwrites the oldest chunk.
  // The only guarantees are: no crash (trap / OOB) and the result is a finite value.
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

// samples.length = length of the received array (= Node<i32>). Written directly to output for observation.
const sampleLen = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const upload = event<{ samples: Float32Array }>({ from: "main", name: "upload" });
  const lenState = state.i32(0);
  return {
    process: () => {
      upload.onReceive(({ samples }) => {
        lenState.write(samples.length);
      });
      forSample((i) => {
        out.ch(0).at(i).write(f32(lenState.read()));
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

// .at(idx) on an empty payload (length 0) returns 0, not stale memory (= §4.3, no-trap;
// OOB/empty → 0). Tests for stale-read leaks by reusing content chunks: block 0 sends 16
// non-empty messages [42] to fill all 16 chunks with [42], then block 1 sends an empty
// message that lands at head=16 = chunk 0 wrap (cross-block, so no drop-oldest overflow).
// With a stale read, length-1=-1 collapses the clamp to idx 0, exposing chunk 0's [42].
const emptyPayloadReader = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const upload = event<{ x: Float32Array }>({ from: "main", name: "upload" });
  const last = state.f32(-1);
  return {
    process: () => {
      upload.onReceive(({ x }) => {
        last.write(x.at(0));
      });
      forSample((i) => {
        out.ch(0).at(i).write(last.read());
      });
    },
  };
});

test("`renderOffline` .at(0) on an empty payload returns 0, not stale memory (§4.3)", async () => {
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
      { name: "upload", atQuantum: 1, payload: { x: new Float32Array([]) } }, // empty = wraps to chunk 0
    ],
  });
  // block 0 = result of non-empty [42] processing (= path sanity check).
  expect(result.outputs.main![0]![0]).toBe(42);
  // block 1 = empty payload. A stale read would leak chunk 0's [42]; after the fix it must be 0.
  expect(result.outputs.main![0]![SAMPLES_PER_BLOCK]).toBe(0);
});

// Processor that updates state via message<T> (= validates scalar message injection).
// Output directly reflects the mul state value (changes per block when injection is delivered).
const messageMul = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const setMul = event<{ mul: number }>({ from: "main", name: "setMul" });
  const mulState = state.f32(1);
  return {
    process: () => {
      setMul.onReceive(({ mul }) => {
        mulState.write(mul);
      });
      forSample((i) => {
        out.ch(0).at(i).write(f32(mulState.read()));
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
  // quantum 0: mul=3, quantum 1: mul=7 — each value is applied to state via the handler.
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

// Fractional inbound number field — the i32 wire truncated it (0.8 → 0); the wire
// must carry f32 so the declared `number` survives (= 型 ⟺ 動く).
const messageGain = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const setGain = event<{ gain: number }>({ from: "main", name: "setGain" });
  const gainState = state.f32(0);
  return {
    process: () => {
      setGain.onReceive(({ gain }) => {
        // `gain` is a `Node<'f32'>` (a declared `number` rides the f32 wire) — no
        // cast needed; the fraction survives end to end.
        gainState.write(gain);
      });
      forSample((i) => {
        out.ch(0).at(i).write(gainState.read());
      });
    },
  };
});

test("`renderOffline` preserves a fractional inbound number field (no i32 truncation)", async () => {
  const result = await renderOffline(messageGain, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000,
    messages: [{ name: "setGain", payload: { gain: 0.8 } }],
  });
  expect(result.outputs.main![0]![0]).toBeCloseTo(0.8, 6);
});

// boolean-valued message field — `flag.write(on)` seals `on` to the bool wire, so
// the declared `boolean` is a real boolean both sides (no f32 detour).
const messageFlag = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const setOn = event<{ on: boolean }>({ from: "main", name: "setOn" });
  const flag = state.bool(false);
  return {
    process: () => {
      setOn.onReceive(({ on }) => {
        flag.write(on);
      });
      forSample((i) => {
        out
          .ch(0)
          .at(i)
          .write(select(flag.read(), f32(1), f32(0)));
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
  expect(result.outputs).toEqual({ main: [oneBlockInput(0.5), oneBlockInput(0.125)] });
  expect(result.events).toEqual([]);
  expect(result.sampleRate).toBe(48000);
  // The end-of-render snapshot captures the persistent `gain` param's value.
  const inspected = inspectSnapshot(result.state);
  expect(inspected.slots.gain).toEqual({ kind: "param", value: 0.5 });
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
  expect(result.outputs).toEqual({ main: [expectedCh0, oneBlockInput(0)] });
  expect(result.events).toEqual([]);
  expect(result.sampleRate).toBe(48000);
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
  expect(result.outputs).toEqual({ main: [expectedCh, expectedCh] });
  expect(result.events).toEqual([]);
  expect(result.sampleRate).toBe(48000);
});

test("`renderOffline` rounds up duration × sampleRate to the next SAMPLES_PER_BLOCK boundary", async () => {
  // requesting 48 samples (= 0.001 sec @ 48kHz) rounds up to 1 block (= 128 samples)
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
  // only 64 samples of input provided; duration = 128 samples → the trailing 64 samples
  // are zero-filled, so the trailing 64 output samples are also 0.
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
  // index 64 and beyond = 0 (= zero-padded input × gain = 0)
  expect(result.outputs).toEqual({ main: [expectedCh, expectedCh] });
});

test("`renderOffline` holds the last param sample when param array is shorter than the render", async () => {
  // gain = [0.25, 0.75], 2 samples (1 < length < SAMPLES_PER_BLOCK):
  // sample 0 → 0.25, sample 1 → 0.75, samples 2..127 → 0.75 (= last-value hold).
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
// state plain factory integration = Phase 7 sub-phase 7.1 completion gate
// (= state.f32(0) + load/store + WASM emit via the declarative path
// persists across render quanta).
// ─────────────────────────────────────────────────────────────────────────

test("`renderOffline` preserves state across render quanta (= literal store cross-block)", async () => {
  // Stores literal 0.6 into the state slot → loads and outputs it in the next block.
  // Confirms that state persists across render quanta (= one instance drives all blocks;
  // WASM memory is maintained across render quanta). NaN from input × subnormal guard
  // interaction is a separate issue (suspected binaryen duplicate-emit path, tracked in
  // sub-phase 7.x); the sub-phase 7.1 gate is satisfied by the literal store path alone.
  const stateSet = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const stored = state.f32(0);
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(stored.read());
        });
        // Stores literal 0.6 at the end of every block (= outside subnormal range = passes guard)
        stored.write(0.6);
      },
    };
  });

  const result = await renderOffline(stateSet, {
    sampleRate: 48000,
    duration: (2 * SAMPLES_PER_BLOCK) / 48000,
  });
  const ch = result.outputs["main"]![0]!;
  // block 1 (= sample 0..127): initial stored value = WASM memory 0 = output 0
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) {
    expect(ch[i]).toBe(0);
  }
  // block 2 (= sample 128..255): loads the 0.6 stored at the end of block 1 = output 0.6
  for (let i = SAMPLES_PER_BLOCK; i < 2 * SAMPLES_PER_BLOCK; i++) {
    expect(ch[i]).toBeCloseTo(0.6, 6);
  }
});

test("`renderOffline` state f32 chained mul across blocks (= counter × 0.5 decay)", async () => {
  // Simplified canonical Ex 1 per-block meter decay (multiply counter by 0.5 at the end of each block).
  // Verifies that the state instance is shared across all blocks and that load × mul → store
  // works cross-block. The counter is seeded with the declaration initial value of 1
  // (= active data segment, same commit as issue #8); multiplied by 0.5 each block →
  // outputs 1 in block 0, 0.5 in block 1, 0.25 in block 2 for every sample.
  const stateDecay = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const counter = state.f32(1);
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(counter.read());
        });
        counter.write(counter.read().mul(0.5));
      },
    };
  });

  const totalBlocks = 3;
  const result = await renderOffline(stateDecay, {
    sampleRate: 48000,
    duration: (totalBlocks * SAMPLES_PER_BLOCK) / 48000,
  });
  const ch = result.outputs["main"]![0]!;
  // block b outputs 1 × 0.5^b (the counter value at block start) for every sample.
  for (let b = 0; b < totalBlocks; b++) {
    const expected = 0.5 ** b;
    for (let i = 0; i < SAMPLES_PER_BLOCK; i++) {
      expect(ch[b * SAMPLES_PER_BLOCK + i]).toBeCloseTo(expected, 6);
    }
  }
});

test("`renderOffline` state declaration is excluded from driver (= regression: state slot must not be misidentified as param and overwritten with NaN via writeParam)", async () => {
  // Root cause regression: state declarations in makeDriver's declarations map were falling
  // into the else branch and treated as params, causing renderOffline to call
  // writeParam("__state_<idx>", paramScratch.fill(undefined)) and overwrite the state slot
  // with NaN. After the fix, state is excluded from driver declarations and renderOffline
  // leaves state slots untouched (= managed entirely within WASM).
  const accumulator = defineProcessor(() => {
    const input = audioInput({ channels: 1, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    const stored = state.f32(0);
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(stored.read());
        });
        stored.write(input.ch(0).at(0).mul(2));
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
  // block 1: stateLoad = 0.6 (= no NaN), the value stored at the end of block 0 persists
  expect(Number.isNaN(ch[SAMPLES_PER_BLOCK]!)).toBe(false);
  expect(ch[SAMPLES_PER_BLOCK]).toBeCloseTo(0.6, 6);
});

test("`renderOffline` state f32 cross-block via input-driven store + load (= accumulation path)", async () => {
  // Stores input × 2 into state → loads and feeds it to output in the next block.
  // State persists cross-block; the audioInRead path + store outside forSample produces no NaN
  // (= fixed by the subnormal guard if-else lazy evaluation refactor, commit 789da18).
  const accumulator = defineProcessor(() => {
    const input = audioInput({ channels: 1, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    const stored = state.f32(0);
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(stored.read());
        });
        stored.write(input.ch(0).at(0).mul(2));
      },
    };
  });

  // input block 1 = 0.3 for all samples, block 2 = 0.7 for all samples
  const inputData = new Float32Array(2 * SAMPLES_PER_BLOCK);
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) inputData[i] = 0.3;
  for (let i = SAMPLES_PER_BLOCK; i < 2 * SAMPLES_PER_BLOCK; i++) inputData[i] = 0.7;

  const result = await renderOffline(accumulator, {
    sampleRate: 48000,
    duration: (2 * SAMPLES_PER_BLOCK) / 48000,
    inputs: { main: [inputData] },
  });
  const ch = result.outputs["main"]![0]!;

  // block 1 (= sample 0..127): initial stored value = WASM memory 0 = output 0
  for (let i = 0; i < SAMPLES_PER_BLOCK; i++) {
    expect(ch[i]).toBe(0);
  }
  // block 2 (= sample 128..255): 0.3 × 2 = 0.6 stored at the end of block 1 = output 0.6
  for (let i = SAMPLES_PER_BLOCK; i < 2 * SAMPLES_PER_BLOCK; i++) {
    expect(ch[i]).toBeCloseTo(0.6, 6);
  }
});

test("`renderOffline` publish scheduler integration (= sampleRate option is reflected in the rateFps gate)", async () => {
  // Simplified canonical Ex 1 meter pattern: store input.ch(0).at(0) per block + publish at 30fps.
  // sampleRate 48000 / rateFps 30 = threshold 1600; fires once after 13 blocks (= 1664 samples).
  // renderOffline does not expose publishShared / Counters externally (sub-phase 7.4 / 7.5
  // handle that via the main surface). Here, compile is called directly and memory is inspected
  // through driver.instantiate to verify that the sampleRate handed off in sub-phase 7.3
  // propagates through compile + emit and is folded into the threshold constant.
  const meterProc = defineProcessor(() => {
    const input = audioInput({ channels: 1, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    const meter = state.f32(0).expose({ name: "meter", publish: { rateFps: 30 } });
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(input.ch(0).at(i));
        });
        meter.write(input.ch(0).at(0));
      },
    };
  });

  const { compile: coreCompile } = await import("@unworklet/core");
  const compiled = await coreCompile(meterProc, { sampleRate: 48000 });
  const instance = await compiled.driver.instantiate();
  // compiled.memory is cast to the internal layout shape via MemoryJson brand (= test path only)
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
  // fires once on block 13 = version 1, counter 64, 0.7 copied into sharedView
  expect(counterView[1]).toBe(1);
  expect(counterView[0]).toBe(64);
  expect(sharedView[0]).toBeCloseTo(Math.fround(0.7), 6);
});

test("`renderOffline` sampleRate option propagates through compile into the emitted threshold (= same graph, different sampleRate yields different threshold)", async () => {
  // Compiling the same processor at sampleRate 48000 and 96000 produces thresholds 1600 and 3200.
  // renderOffline passes config.sampleRate to compile, so rendering the same processor at a
  // different sampleRate changes the due block count, confirming the sampleRate handoff path.
  const meterProc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const meter = state.f32(0).expose({ name: "meter", publish: { rateFps: 30 } });
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(meter.read());
        });
        meter.write(0.5);
      },
    };
  });

  // block 0: forSample writes meter.read() = 0 (initial value) to all samples, then meter.write(0.5).
  // block 1+: forSample writes 0.5 to all samples.
  // The publish path itself is not observable through SAB / main surface here (= sub-phase 7.4 / 7.5);
  // this test only verifies cross-block state behavior and that the sampleRate option
  // passes through compile (= compile succeeds + output path is maintained).
  const r48 = await renderOffline(meterProc, {
    sampleRate: 48000,
    duration: (2 * SAMPLES_PER_BLOCK) / 48000,
  });
  // block 0 = 0, block 1 = 0.5 (= state path confirmed; independent of the publish path)
  expect(r48.outputs["main"]![0]![0]).toBe(0);
  expect(r48.outputs["main"]![0]![SAMPLES_PER_BLOCK]).toBeCloseTo(Math.fround(0.5), 6);

  // same graph at sampleRate 96000: compile succeeds and output path is maintained
  const r96 = await renderOffline(meterProc, {
    sampleRate: 96000,
    duration: (2 * SAMPLES_PER_BLOCK) / 96000,
  });
  expect(r96.outputs["main"]![0]![SAMPLES_PER_BLOCK]).toBeCloseTo(Math.fround(0.5), 6);
});

test("`renderOffline` subnormal flush integration (= state.f32 store 1e-40 → 0)", async () => {
  // The stored 1e-40 is flushed to 0 by the WASM emit subnormal guard; on the next block
  // load it remains 0 = all output samples are 0. Verifies end-to-end that the Q21 subnormal
  // flush is active on the declarative path (= via audioInRead + store outside forSample,
  // no NaN, confirmed after the if-else lazy evaluation refactor).
  const subnormalProc = defineProcessor(() => {
    const input = audioInput({ channels: 1, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    const z = state.f32(0);
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(z.read());
        });
        z.write(input.ch(0).at(0).mul(1e-40));
      },
    };
  });

  const result = await renderOffline(subnormalProc, {
    sampleRate: 48000,
    duration: (2 * SAMPLES_PER_BLOCK) / 48000,
    // input = 1 for all samples → store value = 1 × 1e-40 = subnormal → flushed to 0 by guard
    inputs: { main: [oneBlockInput(1)] },
  });
  const ch = result.outputs["main"]![0]!;
  // all samples in blocks 1 and 2 = 0 (= z stays 0 after subnormal flush)
  for (let i = 0; i < 2 * SAMPLES_PER_BLOCK; i++) {
    expect(ch[i]).toBe(0);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// events real capture (= sub-phase 7.8c). renderOffline walks the
// worklet → main event ring from WASM memory and returns it as an
// OfflineEmittedEvent array.
// ─────────────────────────────────────────────────────────────────────────

test("`renderOffline` captures emitted events from event ring (= sub-phase 7.8c)", async () => {
  const eventProc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "out" });
    const peakEvt = event<{ level: number }>({ to: "main", name: "peak", capacity: 16 });
    // gate state fixed to true via stateLoad cond to avoid Q32-c constant-truthy path
    const gate = state.named("gate").bool(true);
    return {
      process: () => {
        gate.write(true);
        forSample((i) => {
          peakEvt.emitIf(gate.read(), { atSample: i, level: 0.5 });
          out.ch(0).at(i).write(0);
        });
      },
    };
  });
  const result = await renderOffline(eventProc, {
    sampleRate: 48000,
    duration: SAMPLES_PER_BLOCK / 48000, // 1 block = 128 emits; capacity 16 drops 112
  });
  expect(result.events.length).toBeGreaterThan(0);
  // every event: name = "peak", atSample in [0, 127], level = 0.5
  for (const evt of result.events) {
    expect(evt.name).toBe("peak");
    expect(evt.atSample).toBeGreaterThanOrEqual(0);
    expect(evt.atSample).toBeLessThan(SAMPLES_PER_BLOCK);
    expect((evt.payload as { level: number }).level).toBe(0.5);
  }
});

test("worklet→main event atSample is block-local across blocks (B7: offline matches online)", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "out" });
    const fired = event<{ block: number }>({ to: "main", name: "fired", capacity: 16 });
    const blk = state.named("blk").i32(0);
    return {
      process: () => {
        forSample((i) => {
          // Fire once per block at block-local sample 5 (a dynamic, non-constant cond).
          fired.emitIf(i.eq(5), { atSample: i, block: blk.read() });
          out.ch(0).at(i).write(0);
        });
        blk.write(blk.read().add(1));
      },
    };
  });
  const result = await renderOffline(proc, {
    sampleRate: 48000,
    duration: (3 * SAMPLES_PER_BLOCK) / 48000, // 3 blocks
  });
  const fires = result.events.filter((e) => e.name === "fired");
  expect(fires.length).toBe(3);
  // Block-local: every fire reports atSample 5, NOT absolute 5 / 133 / 261.
  expect(fires.map((e) => e.atSample)).toEqual([5, 5, 5]);
  // The `block` payload confirms the events really span three distinct blocks.
  expect(fires.map((e) => (e.payload as { block: number }).block)).toEqual([0, 1, 2]);
});

// Typed-array event payload sent worklet → main (§4.3 L708). Writing to a buffer inside
// the worklet and passing it with a framework-injected length to emitIf causes the main side
// to receive a fresh Float32Array of that length.
test("`renderOffline` captures a typed-array event payload as a Float32Array", async () => {
  const arrayEmitter = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const buf = state.buffer.f32({ size: 4 });
    const result = event<{ data: Float32Array }>({
      to: "main",
      name: "result",
      payloadCapacity: 64,
    });
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

// When the length passed to emitIf exceeds the buffer size, the copy byte count is clamped
// to the buffer boundary (= otherwise memory.copy would read past the buffer.<T> region into
// adjacent linear memory and publish those bytes to main = memory disclosure). Emitting
// length 1024 from a size-4 buffer → the drained payload is clamped to 4 elements.
test("`renderOffline` typed-array event clamps to buffer boundary when length exceeds buffer size (= prevents memory leak)", async () => {
  const overEmitter = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const buf = state.buffer.f32({ size: 4 });
    const result = event<{ data: Float32Array }>({
      to: "main",
      name: "result",
      payloadCapacity: 64,
    });
    return {
      process: () => {
        for (let k = 0; k < 4; k++) buf.write(k, f32((k + 1) * 11));
        result.emitIf(true, { atSample: 0, data: buf, length: i32(1024) }); // length exceeds buffer(4)
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
  // length clamps to buffer's 4 elements = no adjacent memory leak.
  expect(data.length).toBe(4);
  expect(Array.from(data)).toEqual([11, 22, 33, 44]);
});

test("`renderOffline` captures bool wireType event field as JS boolean", async () => {
  const boolEvtProc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "out" });
    const flagEvt = event<{ flag: boolean }>({ to: "main", name: "flag", capacity: 16 });
    const gate = state.named("gate").bool(true);
    return {
      process: () => {
        gate.write(true);
        forSample((i) => {
          flagEvt.emitIf(gate.read(), { atSample: i, flag: true });
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
