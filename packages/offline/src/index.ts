/**
 * `@unworklet/offline` — pure-JS offline renderer (`13-offline-render.md`).
 *
 * Single public entry point `renderOffline(processor, config)` runs an
 * `@unworklet/core` processor through host JS's `WebAssembly.instantiate`
 * (= Node / Bun / Deno) and returns the resulting PCM + emitted events +
 * end-of-render snapshot blob.
 *
 * Internally calls `compile(processor)` to obtain the WASM binary and the
 * driver-friendly handle (= `result.driver.instantiate()`)、 そ の handle 越 し
 * に memory I/O + process() を render quantum 単 位 で 反 復。
 *
 * Phase 3 = audio I/O + param 反 映 path だ け fill (= events / state は
 * Phase 7 / 11 で fill)。 duration × sampleRate を `SAMPLES_PER_BLOCK` で
 * 切 り 上 げ た sample 数 ま で render (= `13-offline-render.md` §2.1)。
 */

import type { CompiledProcessor } from "@unworklet/core";
import { compile, extractWorkletMeta, SAMPLES_PER_BLOCK } from "@unworklet/core";

export { encodeWav } from "./encodeWav.ts";
export type { EncodeWavBitDepth, EncodeWavOptions } from "./encodeWav.ts";

export { decodeWav } from "./decodeWav.ts";
export type { DecodeWavResult } from "./decodeWav.ts";

/** Single main → worklet message scheduled for an offline render. */
export type OfflineMessage = {
  name: string;
  payload: unknown;
  /** Delivery quantum (block index, 0-based). Omitted = 0 (= render start). */
  atQuantum?: number;
};

/** Single inbound event injected at a sample-accurate offset. */
export type OfflineEvent = {
  name: string;
  payload: unknown;
  atSample: number;
};

/** Single worklet → main event recorded during a render. */
export type OfflineEmittedEvent = {
  name: string;
  payload: unknown;
  atSample: number;
};

export type RenderOfflineConfig = {
  sampleRate: number;
  /** Render duration in seconds; rounded up to the next `SAMPLES_PER_BLOCK` boundary. */
  duration: number;
  /** Audio input per declared `audioInput({ name })` port. Key = port name, value = per-channel `Float32Array`. */
  inputs?: Record<string, Float32Array[]>;
  /** Param automation per declared `param.named(...)` slot. Key = param name. */
  params?: Record<string, number[]>;
  /** Main → worklet messages scheduled by quantum index. */
  messages?: OfflineMessage[];
  /** Inbound events scheduled by sample-accurate offset. */
  events?: OfflineEvent[];
  /** Snapshot profile name; omitted = union of every `'persistent'` profile. */
  profile?: string;
};

export type RenderOfflineResult = {
  /** Output PCM per declared `audioOutput({ name })` port. */
  outputs: Record<string, Float32Array[]>;
  /** Events the processor emitted during the render. */
  events: OfflineEmittedEvent[];
  /** Snapshot blob (Q5 format) captured at end-of-render. */
  state: Uint8Array;
  /** Sample rate used for the render (= `config.sampleRate` carry、 wav 書 き 出 し / 再 render / consumer 自 動 化 で self-describe)。 */
  sampleRate: number;
};

/** message / event ringbuffer header = [head, tail, overflowCount] × 4 byte。 */
const MESSAGE_HEADER_BYTES = 12;

export async function renderOffline<C>(
  processor: CompiledProcessor<C>,
  config: RenderOfflineConfig,
): Promise<RenderOfflineResult> {
  // compile に config.sampleRate を hand (= sub-phase 7.3) = publish scheduler の
  // threshold = `Math.round(sampleRate / rateFps)` が build-time const fold さ れ る。
  const result = await compile(processor, { sampleRate: config.sampleRate });
  const instance = await result.driver.instantiate();

  // event ring meta を WorkletMeta 経 由 で 取 得 (= renderOffline 内 で WASM
  // memory か ら 直 接 ring を walk = SAB 不 在 で も per-quantum 末 尾 で drain
  // し て OfflineEmittedEvent 配 列 に 蓄 積)。
  const meta = extractWorkletMeta(processor.graph as never);
  const eventRingMeta = meta.events.map((evt) => {
    const slot = meta.layout.regions.eventRings.slots[evt.name]!;
    return {
      name: evt.name,
      base: slot.base,
      capacity: slot.capacity,
      slotSize: slot.slotSize,
      fields: slot.fields,
      // typed-array field (§4.3 worklet→main) の中身を読む content region。
      payloadContent: meta.layout.regions.payloadContent.eventSlots[evt.name],
    };
  });
  const emittedEvents: OfflineEmittedEvent[] = [];

  // message ring meta (= main → worklet 注入用)。 worklet template の SAB 経路と
  // 違い、 offline は WASM memory の ring header / slot を直接 poke して 1 quantum
  // 先頭で push する (= event drain と対称の手書き transport)。
  const messageRingMeta = meta.messages.map((msg) => {
    const slot = meta.layout.regions.messageRings.slots[msg.name]!;
    return {
      name: msg.name,
      base: slot.base,
      capacity: slot.capacity,
      slotSize: slot.slotSize,
      // typed-array field の 中 身 を 置 く content region (= ナ シ な ら undefined)。
      payloadContent: meta.layout.regions.payloadContent.messageSlots[msg.name],
      fields: slot.fields,
    };
  });

  const totalSamples =
    Math.ceil((config.duration * config.sampleRate) / SAMPLES_PER_BLOCK) * SAMPLES_PER_BLOCK;
  const blocks = totalSamples / SAMPLES_PER_BLOCK;

  const outputs: Record<string, Float32Array[]> = {};
  for (const decl of instance.declarations) {
    if (decl.kind === "audioOutput") {
      outputs[decl.name] = Array.from(
        { length: decl.channels },
        () => new Float32Array(totalSamples),
      );
    }
  }

  const blockBuffer = new Float32Array(SAMPLES_PER_BLOCK);
  const inputScratch = new Float32Array(SAMPLES_PER_BLOCK);
  const paramScratch = new Float32Array(SAMPLES_PER_BLOCK);

  for (let b = 0; b < blocks; b++) {
    const blockStart = b * SAMPLES_PER_BLOCK;

    for (const decl of instance.declarations) {
      if (decl.kind === "audioInput") {
        const channels = config.inputs?.[decl.name] ?? [];
        for (let c = 0; c < decl.channels; c++) {
          const channelData = channels[c];
          if (channelData) {
            for (let s = 0; s < SAMPLES_PER_BLOCK; s++) {
              const abs = blockStart + s;
              inputScratch[s] = abs < channelData.length ? channelData[abs]! : 0;
            }
          } else {
            inputScratch.fill(0);
          }
          instance.writeInput(decl.name, c, inputScratch);
        }
      } else if (decl.kind === "param") {
        const data = config.params?.[decl.name];
        if (!data || data.length === 0) {
          paramScratch.fill(decl.default);
        } else if (data.length === 1) {
          paramScratch.fill(data[0]!);
        } else {
          for (let s = 0; s < SAMPLES_PER_BLOCK; s++) {
            const abs = blockStart + s;
            paramScratch[s] = abs < data.length ? data[abs]! : data[data.length - 1]!;
          }
        }
        instance.writeParam(decl.name, paramScratch);
      }
    }

    // message 注入 (= こ の quantum 宛 て の scheduled message を ring head に push)。
    // worklet の onReceive drain (= process 冒 頭、 Q38-b) が tail→head を 消 化 す る。
    // tail は 前 quantum の drain で head に commit 済 = 各 quantum で ring は空 start。
    for (const m of config.messages ?? []) {
      if ((m.atQuantum ?? 0) !== b) continue;
      const ring = messageRingMeta.find((r) => r.name === m.name);
      if (ring === undefined) {
        throw new Error(
          `unworklet: renderOffline message "${m.name}" has no matching message<T> declaration`,
        );
      }
      const memory = instance.memory.buffer;
      const headerView = new Int32Array(memory, ring.base, 3);
      const head = headerView[0]!;
      const slotByteOffset =
        ring.base + MESSAGE_HEADER_BYTES + (head % ring.capacity) * ring.slotSize;
      const dataView = new DataView(memory);
      const payload = m.payload as Record<string, unknown>;
      for (const field of ring.fields) {
        const byteOffset = slotByteOffset + field.offsetInSlot;
        if (field.payloadElementType !== undefined) {
          // typed-array field = 中 身 を payloadContent の per-slot chunk に 書 き、
          // slot に [payloadLen(bytes), payloadOffset] を set (= §5.2 / Q85)。 1 quantum に
          // 複 数 message を queue し て も content が 上 書 き さ れ な い よ う、 chunk =
          // (head % chunks) × perChunk で slot ご と に 分 け る (= emit / SAB と 対 称)。
          // chunks 枠 を 超 え た 連 射 は 循 環 再 利 用 = drop-oldest (= trap し な い)。
          const src = payload[field.name] as Float32Array;
          const content = ring.payloadContent!;
          const perChunk = Math.floor(content.capacity / content.chunks);
          const payloadOffset = (head % content.chunks) * perChunk;
          const byteLen = Math.min(src.length * src.BYTES_PER_ELEMENT, perChunk);
          new Uint8Array(memory, content.base + payloadOffset, byteLen).set(
            new Uint8Array(src.buffer, src.byteOffset, byteLen),
          );
          dataView.setInt32(byteOffset, byteLen, true); // payloadLen (= bytes)
          dataView.setInt32(byteOffset + 4, payloadOffset, true); // payloadOffset (= per-slot chunk)
        } else {
          // scalar field = Q46 で 現 状 全 て i32 wire (= number / boolean → i32 word)。
          dataView.setInt32(byteOffset, Number(payload[field.name]) | 0, true);
        }
      }
      headerView[0] = head + 1; // head を 1 slot 進 め る (= push)
    }

    instance.process();

    // event ring drain (= 各 quantum 末 尾 で WASM ring の head が 進 ん だ 分 を
    // OfflineEmittedEvent に 蓄 積)。 WASM 内 ring は per-quantum 完 結 = ring tail
    // を 進 め な い と drop-oldest が 連 発 す る path = drain 後 tail = head に
    // commit (= WASM memory 経 由 で 直 接 store)。
    for (const ring of eventRingMeta) {
      const memory = instance.memory.buffer;
      const headerView = new Int32Array(memory, ring.base, 3);
      let head = headerView[0]!;
      let tail = headerView[1]!;
      while (tail !== head) {
        const slotIdx = tail % ring.capacity;
        const slotByteOffset = ring.base + 12 + slotIdx * ring.slotSize;
        const dataView = new DataView(memory);
        const payload: Record<string, unknown> = {};
        let atSample = 0;
        for (const field of ring.fields) {
          const byteOffset = slotByteOffset + field.offsetInSlot;
          // typed-array field (§4.3) = slot の [payloadLen, payloadOffset] を読んで
          // content region から fresh Float32Array を切り出す (= main 側は natural array)。
          if (field.payloadElementType !== undefined) {
            const payloadLen = dataView.getInt32(byteOffset, true); // bytes
            const payloadOffset = dataView.getInt32(byteOffset + 4, true);
            const srcBase = ring.payloadContent!.base + payloadOffset;
            const bytes = memory.slice(srcBase, srcBase + payloadLen); // fresh copy
            payload[field.name] =
              field.payloadElementType === "f64"
                ? new Float64Array(bytes)
                : field.payloadElementType === "u8"
                  ? new Uint8Array(bytes)
                  : field.payloadElementType === "i32" || field.payloadElementType === "bool"
                    ? new Int32Array(bytes)
                    : field.payloadElementType === "i64"
                      ? new BigInt64Array(bytes)
                      : new Float32Array(bytes);
            continue;
          }
          let value: number | boolean | bigint;
          switch (field.wireType) {
            case "i32":
            case "bool":
              value =
                field.wireType === "bool"
                  ? dataView.getInt32(byteOffset, true) !== 0
                  : dataView.getInt32(byteOffset, true);
              break;
            case "f32":
              value = dataView.getFloat32(byteOffset, true);
              break;
            /* v8 ignore start — f64 / i64 event field は sub-phase 7.6 段 階 で
               typed-array path と zip で 別 commit fill = unreachable defensive */
            case "f64":
              value = dataView.getFloat64(byteOffset, true);
              break;
            case "i64":
              value = dataView.getBigInt64(byteOffset, true);
              break;
            /* v8 ignore stop */
          }
          if (field.name === "atSample" && typeof value === "number") {
            atSample = blockStart + value;
          } else {
            payload[field.name] = value;
          }
        }
        emittedEvents.push({ name: ring.name, payload, atSample });
        tail += 1;
      }
      // drain 後 tail = head に commit (= 次 quantum で WASM ring が 空 状 態 で
      // start、 drop-oldest 連 発 を 防 ぐ)。 ま た overflowCount も リ セ ッ ト ナ シ
      // (= monotonic 維 持)。
      headerView[1] = head;
    }

    for (const decl of instance.declarations) {
      if (decl.kind !== "audioOutput") continue;
      for (let c = 0; c < decl.channels; c++) {
        instance.readOutput(decl.name, c, blockBuffer);
        const dest = outputs[decl.name]![c]!;
        for (let s = 0; s < SAMPLES_PER_BLOCK; s++) {
          dest[blockStart + s] = blockBuffer[s]!;
        }
      }
    }
  }

  return {
    outputs,
    events: emittedEvents,
    state: new Uint8Array(0),
    sampleRate: config.sampleRate,
  };
}
