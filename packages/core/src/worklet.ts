/**
 * `CompiledProcessor.worklet` 関数 namespace の 中身 (= `01-dsl.md` §11、
 * `04-worklet-runtime.md` §2、 Q80)。
 *
 * `makeWorkletNamespace(graph)` は per-processor closure を 返す。 中身 3 件:
 *
 * - `initialize(self, opts)` — `opts.processorOptions.wasm` の bytes を sync
 *   path で 即 instantiate (= `new WebAssembly.Module` / `new WebAssembly.Instance`
 *   は AudioWorkletGlobalScope + Node test の 両 環境 で 同 等 に 動 く)、
 *   driver state を `self` の internal symbol 経 由 で 保 存、 `port.postMessage`
 *   で readiness ack。
 * - `process(self, inputs, outputs, parameters)` — `04-worklet-runtime.md` §2
 *   step 順 で 走 る: block-length guard (= Q75) → input/param marshal → WASM
 *   process → output marshal → return true。
 * - `parameterDescriptors` — graph 内 の `param` declaration を Web Audio の
 *   `AudioParamDescriptor` 形 に 変 換。
 *
 * 自 動 register path (= vite-plugin が emit する worklet JS template) と
 * escape hatch path (= user 自 前 の `class extends AudioWorkletProcessor`、
 * Q80) の 両 方 が こ の 関 数 namespace を 共 通 基 盤 と し て 使 う。
 */

import type {
  AudioPortDecl,
  CapturedGraph,
  EventDeclAst,
  ParamDecl,
  StateDecl,
} from "./compile/ast.ts";
import { layout, type Layout } from "./compile/layout.ts";
import { SAMPLES_PER_BLOCK } from "./dsl/constants.ts";
import type {
  EventRingSlotDescriptor,
  PublishSlotDescriptor,
  TransportMode,
  WorkletNamespace,
} from "./types.ts";

/**
 * Metadata bundle that fully describes a processor's worklet-side runtime
 * shape — everything needed to build a `WorkletNamespace` without
 * re-evaluating the authoring source。 The vite-plugin computes this at
 * build / dev time from `compile(processor)` and inlines it (as JSON) into
 * the emitted worklet entry, so `audioWorklet.addModule()` only ever loads
 * a runtime-only artifact (= no `?worklet` virtual ever re-runs `defineProcessor`
 * inside `AudioWorkletGlobalScope`)。
 */
export type WorkletMeta = {
  readonly layout: Layout;
  readonly audioInputs: readonly AudioPortDecl[];
  readonly audioOutputs: readonly AudioPortDecl[];
  readonly params: readonly ParamDecl[];
  /**
   * publish flag を 持 つ state declaration 一 覧 (= sub-phase 7.4 で SAB copy
   * logic が 参 照)。 layout.regions.publishShared / publishCounters と zip で
   * 各 slot の WASM memory offset + 型 (= f32 / i32 / bool で SAB copy 方 法 が
   * 異 な る、 Q42 で 全 4 byte word) を 取 得 す る path。
   */
  readonly publishStates: readonly StateDecl[];
  /**
   * `event<T>` declaration 一 覧 (= sub-phase 7.6)。 declaration 順 で layout
   * の eventRings slot と zip。 worklet template が per-quantum 末 尾 で WASM
   * ring → SAB ring に copy する path で 参 照。
   */
  readonly events: readonly EventDeclAst[];
};

export function extractWorkletMeta(graph: CapturedGraph): WorkletMeta {
  return {
    layout: layout(graph),
    audioInputs: graph.declarations.filter((d): d is AudioPortDecl => d.kind === "audioInput"),
    audioOutputs: graph.declarations.filter((d): d is AudioPortDecl => d.kind === "audioOutput"),
    params: graph.declarations.filter((d): d is ParamDecl => d.kind === "param"),
    publishStates: graph.declarations.filter(
      (d): d is StateDecl => d.kind === "state" && d.publish !== undefined,
    ),
    events: graph.declarations.filter((d): d is EventDeclAst => d.kind === "event"),
  };
}

const BYTES_PER_F32 = 4;
const CHANNEL_STRIDE_BYTES = SAMPLES_PER_BLOCK * BYTES_PER_F32;

const STATE_KEY = Symbol("unworklet.workletState");
/**
 * `initialize(self, opts)` was entered at least once。 Used by `process` to
 * distinguish two failure modes when no state is attached to `self`:
 *
 *   - `INIT_CALLED_KEY === true` AND no state → initialize ran but threw
 *     before storing state (= init-error already posted at handshake time)
 *   - `INIT_CALLED_KEY === undefined` AND no state → init was never called
 *     (= path β escape hatch and the author forgot
 *     `def.worklet.initialize(this, opts)` in their constructor — Q80)
 *
 * The second case has no compile-time check (custom class lives in user
 * code), so the runtime posts `worklet-initialize-not-called` once and
 * keeps emitting silence — fail-fast signal to main without throwing on
 * the audio thread (= `00-foundations.md` §5.1 invariant 3)。
 */
const INIT_CALLED_KEY = Symbol("unworklet.initCalled");
const INIT_NOT_CALLED_POSTED_KEY = Symbol("unworklet.initNotCalledPosted");

/**
 * Per-instance worklet state cached on the AudioWorkletProcessor `self`。
 * All `Float32Array` views over WASM linear memory are pre-bound during
 * `initialize(...)` and reused on every render quantum, because
 * `00-foundations.md` §5.1 forbids allocations / GC pressure on the audio
 * thread。 unworklet's WASM module never calls `memory.grow` (= the layout
 * sizing is computed at compile time)、 so these views stay valid for the
 * processor's lifetime — they would otherwise need to be re-bound on every
 * growth event, since growth detaches the backing ArrayBuffer。
 */
type WorkletState = {
  readonly process: () => void;
  readonly audioInputs: readonly AudioPortDecl[];
  readonly audioOutputs: readonly AudioPortDecl[];
  readonly params: readonly ParamDecl[];
  /** Index-aligned with `audioInputs`; inner array is per-channel views。 */
  readonly inputViews: readonly Float32Array[][];
  /** Index-aligned with `audioOutputs`。 */
  readonly outputViews: readonly Float32Array[][];
  /** Index-aligned with `params`。 */
  readonly paramViews: readonly Float32Array[];
  /**
   * publish slot meta + buffer + per-slot lastVersion (= sub-phase 7.4)。
   * publishBuffer = main か ら hand さ れ た SAB or ArrayBuffer (= main 観 測 用)、
   * publishSlots = WASM memory 内 offset map、 lastVersions[i] = i 番 slot で
   * 最 後 に main へ copy し た version (= 同 値 ナ ラ skip)。
   * publishSlots.length === 0 で publishBuffer が null = publish ナ シ processor。
   * publishWasmSharedViews / CounterViews = WASM memory 内 publishShared /
   * publishCounters region の Int32Array view (= initialize で pre-bind、
   * audio thread alloc 回 避)。
   */
  readonly publishSharedView: Int32Array | null;
  readonly publishSlots: readonly PublishSlotDescriptor[];
  readonly lastVersions: number[];
  readonly transport: TransportMode;
  readonly publishWasmSharedViews: readonly Int32Array[];
  readonly publishWasmCounterViews: readonly Int32Array[];
  /**
   * Latched once a WASM trap escapes `state.process()`。 Subsequent quanta
   * emit silence and skip the WASM call so a single trap does not get
   * re-posted every render quantum (= main receives one `wasm-trap` event
   * and the node keeps outputting silence, per docs/05-client.md §4)。
   */
  failed: boolean;
};

type SelfWithState = {
  port: { postMessage: (m: unknown) => void };
  [STATE_KEY]?: WorkletState;
  [INIT_CALLED_KEY]?: boolean;
  [INIT_NOT_CALLED_POSTED_KEY]?: boolean;
};

type ProcessorOptionsBag = {
  processorOptions?: {
    /**
     * Pre-compiled `WebAssembly.Module` minted on the main thread。 Audio
     * thread only does `new WebAssembly.Instance(module)` (= fast、
     * deterministic、 spec-recommended path)。 This is the primary handoff
     * shape produced by `createNode`。
     */
    module?: WebAssembly.Module;
    /**
     * Legacy `Uint8Array` bytes path = sync `new WebAssembly.Module(bytes)`
     * inside `initialize`。 Kept for path β escape hatches (= author自前
     * `class extends AudioWorkletProcessor` that hands raw bytes through
     * `processorOptions`)、 but the declarative path α prefers `.module`。
     */
    wasm?: Uint8Array;
    /**
     * publish slot 用 共 有 buffer (= sub-phase 7.4)。 SAB available 環 境 で は
     * SharedArrayBuffer、 fallback 環 境 で は ArrayBuffer。 worklet template が
     * per-quantum 末 尾 で WASM publishShared / Counters 値 を こ の buffer に copy
     * (= main thread 側 が 同 buffer へ の reference を 既 持 つ、 main / worklet
     * 両 方 か ら 観 測)。 publish ナ シ processor で は hand さ れ な い。
     */
    publishBuffer?: SharedArrayBuffer | ArrayBuffer;
    /**
     * publish slot descriptor 配 列 (= declaration 順、 publishBuffer の slot 配
     * 置 と zip)。 worklet template が WASM memory の どこ か ら read す る か を
     * 各 slot で 取 得 (= sharedOffset / counterOffset)。
     */
    publishSlots?: readonly PublishSlotDescriptor[];
    /**
     * transport mode (= 'sab' or 'postMessage')。 worklet template が copy 経 路
     * を 切 り 替 え る path で 参 照。 default = 'postMessage' (= safer fallback)。
     */
    transport?: TransportMode;
  };
};

const fillOutputsSilent = (outputs: Float32Array[][]): void => {
  for (const port of outputs) {
    for (const channel of port) {
      channel.fill(0);
    }
  }
};

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function makeWorkletNamespace(graph: CapturedGraph): WorkletNamespace {
  return makeWorkletNamespaceFromMeta(extractWorkletMeta(graph));
}

export function makeWorkletNamespaceFromMeta(meta: WorkletMeta): WorkletNamespace {
  const lay = meta.layout;
  const audioInputs = meta.audioInputs;
  const audioOutputs = meta.audioOutputs;
  const params = meta.params;
  const publishStates = meta.publishStates;

  const parameterDescriptors = params.map((p) => ({
    name: p.name,
    defaultValue: p.default,
    minValue: p.min,
    maxValue: p.max,
    automationRate: p.automationRate,
  }));

  const inputDescriptors = audioInputs.map((p) => ({ name: p.name, channels: p.channels }));
  const outputDescriptors = audioOutputs.map((p) => ({ name: p.name, channels: p.channels }));

  // publishSlots = declaration 順 で {name, type, sharedOffset, counterOffset} を 構 築。
  // createNode が transport mode 検 出 + SAB allocate + worklet template が per-quantum 末 尾
  // で WASM memory 経 由 で SAB に copy す る 時 に 参 照 (= sub-phase 7.4 / 7.5)。
  const publishSlots = publishStates.map((s) => ({
    name: s.name,
    type: s.type,
    sharedOffset: lay.regions.publishShared.slots[s.name]!,
    counterOffset: lay.regions.publishCounters.slots[s.name]!,
  }));

  // eventRings = declaration 順 で {name, wasmRingBase, capacity, slotSize, fields} を 構 築。
  // createNode が SAB ringbuffer allocate + worklet template が per-quantum 末 尾 で WASM
  // ring → SAB ring に copy す る 時 に 参 照 (= sub-phase 7.6 commit 5b/5c)。
  const eventRings: EventRingSlotDescriptor[] = meta.events.map((evt) => {
    const slot = lay.regions.eventRings.slots[evt.name];
    /* v8 ignore next 3 — event declaration が 既 capture 段 階 で layout に push
       済 = 構 造 上 unreachable defensive guard */
    if (slot === undefined) {
      throw new Error(`unworklet: missing layout slot for event "${evt.name}"`);
    }
    return {
      name: evt.name,
      wasmRingBase: slot.base,
      capacity: slot.capacity,
      slotSize: slot.slotSize,
      fields: slot.fields,
    };
  });

  const initialize: WorkletNamespace["initialize"] = (...args) => {
    const self = args[0] as SelfWithState;
    const opts = (args[1] ?? {}) as ProcessorOptionsBag;
    // Mark `initialize` as entered so `process()` can tell init-failed
    // (= flag set but no state) from init-never-called (= flag unset),
    // and surface the latter via `worklet-initialize-not-called`。
    self[INIT_CALLED_KEY] = true;
    try {
      // Prefer the pre-compiled `WebAssembly.Module` (= main-thread async
      // compile)、 fall back to sync `new WebAssembly.Module(bytes)` if a
      // path-β escape hatch still hands raw bytes through。 Either way,
      // `new WebAssembly.Instance(module)` happens here in the audio
      // realm — that step is cheap + spec-recommended。
      const wasmModule =
        opts.processorOptions?.module ??
        (opts.processorOptions?.wasm
          ? new WebAssembly.Module(opts.processorOptions.wasm.buffer as ArrayBuffer)
          : null);
      if (!wasmModule) {
        throw new Error(
          "unworklet: `initialize(self, opts)` requires `opts.processorOptions.module` " +
            "(= pre-compiled WebAssembly.Module from main thread) or `opts.processorOptions.wasm` (= legacy bytes)",
        );
      }
      const instance = new WebAssembly.Instance(wasmModule);
      const memory = instance.exports["memory"] as WebAssembly.Memory;
      const procFn = instance.exports["process"] as () => void;

      // Pre-bind one Float32Array view per (port, channel) and per param。
      // Reused on every `process()` call to keep the audio thread alloc-free
      // (= `00-foundations.md` §5.1)。 Memory.grow is never invoked by
      // generated WASM = the views stay valid for the processor's lifetime。
      const inputViews: Float32Array[][] = [];
      for (const decl of audioInputs) {
        const portBase = lay.regions.ioScratch.inputs[decl.name]!;
        const channels: Float32Array[] = [];
        for (let c = 0; c < decl.channels; c++) {
          const channelBase = portBase + c * CHANNEL_STRIDE_BYTES;
          channels.push(new Float32Array(memory.buffer, channelBase, SAMPLES_PER_BLOCK));
        }
        inputViews.push(channels);
      }

      const outputViews: Float32Array[][] = [];
      for (const decl of audioOutputs) {
        const portBase = lay.regions.ioScratch.outputs[decl.name]!;
        const channels: Float32Array[] = [];
        for (let c = 0; c < decl.channels; c++) {
          const channelBase = portBase + c * CHANNEL_STRIDE_BYTES;
          channels.push(new Float32Array(memory.buffer, channelBase, SAMPLES_PER_BLOCK));
        }
        outputViews.push(channels);
      }

      const paramViews: Float32Array[] = [];
      for (const decl of params) {
        const paramBase = lay.regions.ioScratch.params[decl.name]!;
        paramViews.push(new Float32Array(memory.buffer, paramBase, SAMPLES_PER_BLOCK));
      }

      // publish 関 連 meta + buffer を opts か ら 取 り 出 し (= sub-phase 7.4)。
      // publish ナ シ processor は publishBuffer ナ シ で hand さ れ る = view = null、
      // publishSlots = []、 lastVersions = [] で start = process 末 尾 copy logic は
      // 空 walk = no-op。
      const publishBuffer = opts.processorOptions?.publishBuffer ?? null;
      const publishSlots = opts.processorOptions?.publishSlots ?? [];
      const transport = opts.processorOptions?.transport ?? "postMessage";
      const publishSharedView = publishBuffer ? new Int32Array(publishBuffer) : null;
      const lastVersions = publishSlots.map(() => 0);
      // WASM memory 内 publishShared / publishCounters region の view を per-slot
      // で pre-bind = process 末 尾 copy で 毎 quantum alloc を 避 け る
      // (= `00-foundations.md` §5.1 realtime safety)。
      const publishWasmSharedViews: Int32Array[] = [];
      const publishWasmCounterViews: Int32Array[] = [];
      for (const slot of publishSlots) {
        publishWasmSharedViews.push(new Int32Array(memory.buffer, slot.sharedOffset, 1));
        publishWasmCounterViews.push(new Int32Array(memory.buffer, slot.counterOffset, 2));
      }

      (self as SelfWithState)[STATE_KEY] = {
        process: procFn,
        audioInputs,
        audioOutputs,
        params,
        inputViews,
        outputViews,
        paramViews,
        publishSharedView,
        publishSlots,
        lastVersions,
        transport,
        publishWasmSharedViews,
        publishWasmCounterViews,
        failed: false,
      };

      self.port.postMessage({ kind: "ready" });
    } catch (err) {
      // Surface the failure via a structured handshake message so
      // `createNode()` on main can reject with context (= debug clarity
      // beyond `processorerror`, which carries no payload per MDN)。
      // Do NOT rethrow: the audio thread must not propagate exceptions
      // (= `00-foundations.md` §5.1 invariant 3)、 subsequent `process()`
      // calls will see no state and emit silence。
      self.port.postMessage({
        kind: "init-error",
        message: errorMessage(err),
      });
    }
  };

  const process: WorkletNamespace["process"] = (...args): boolean => {
    const self = args[0] as SelfWithState;
    const inputs = args[1] as Float32Array[][];
    const outputs = args[2] as Float32Array[][];
    const parameters = args[3] as Record<string, Float32Array>;

    const state = (self as SelfWithState)[STATE_KEY];
    if (!state) {
      // No state attached = two distinct paths. Post the path-β-specific
      // signal once if `initialize` was never called (= author forgot
      // `def.worklet.initialize(this, opts)`); otherwise stay silent
      // (= initialize ran but threw, in which case `init-error` was
      // already posted during the createNode handshake)。 Either way:
      // emit silence、 `return true` to keep the AudioWorkletProcessor
      // alive、 no throw on the audio thread。
      const initCalled = self[INIT_CALLED_KEY] === true;
      if (!initCalled && !self[INIT_NOT_CALLED_POSTED_KEY]) {
        self.port.postMessage({ kind: "error", code: "worklet-initialize-not-called" });
        self[INIT_NOT_CALLED_POSTED_KEY] = true;
      }
      fillOutputsSilent(outputs);
      return true;
    }
    if (state.failed) {
      // A previous quantum trapped inside `state.process()`. Per
      // docs/05-client.md §4 the node stays connected + outputs silence
      // for the rest of its lifetime — the wasm-trap message was already
      // posted once, do not flood the port。
      fillOutputsSilent(outputs);
      return true;
    }

    // 04-worklet-runtime.md §3 / §8 / Q75 — block-length runtime guard。
    // First mismatch latches `state.failed` (= same uniform fallback path
    // as wasm-trap) so every subsequent quantum stays silent for the rest
    // of the node's lifetime, even if the host transiently returns to the
    // expected length。 The single mismatch event is posted once; later
    // quanta short-circuit on `state.failed` above before reaching here。
    const firstOut = outputs[0]?.[0];
    if (firstOut && firstOut.length !== SAMPLES_PER_BLOCK) {
      state.failed = true;
      fillOutputsSilent(outputs);
      self.port.postMessage({
        kind: "error",
        code: "block-length-mismatch",
        expected: SAMPLES_PER_BLOCK,
        received: firstOut.length,
      });
      return true;
    }

    // Marshal inputs into linear memory ioScratch.inputs[port][channel]。
    // All views were pre-bound in `initialize` = no Float32Array allocation
    // on the audio thread。
    const inputViews = state.inputViews;
    for (let portIdx = 0; portIdx < state.audioInputs.length; portIdx++) {
      const decl = state.audioInputs[portIdx]!;
      const portInput = inputs[portIdx] ?? [];
      const portViews = inputViews[portIdx]!;
      for (let c = 0; c < decl.channels; c++) {
        const view = portViews[c]!;
        const src = portInput[c];
        if (src && src.length === SAMPLES_PER_BLOCK) {
          view.set(src);
        } else {
          view.fill(0);
        }
      }
    }

    // Marshal parameters into linear memory ioScratch.params[name]。
    // AudioWorklet hands us length 0 (= no automation, use declared default),
    // 1 (= k-rate or unchanged a-rate, broadcast), or SAMPLES_PER_BLOCK
    // (= per-sample a-rate). 08-deployment.md §2 A3 unifies them at this seam.
    const paramViews = state.paramViews;
    for (let i = 0; i < state.params.length; i++) {
      const decl = state.params[i]!;
      const view = paramViews[i]!;
      const data = parameters[decl.name];
      if (!data || data.length === 0) {
        view.fill(decl.default);
      } else if (data.length === 1) {
        view.fill(data[0]!);
      } else {
        view.set(data);
      }
    }

    try {
      state.process();
    } catch (err) {
      // WASM trap during process() (= div-by-zero, OOB memory access,
      // unreachable instruction, etc。 V8 surfaces these as JS exceptions
      // of `WebAssembly.RuntimeError` per the WebAssembly spec)。 Latch
      // failed state so subsequent quanta short-circuit, emit silence for
      // this quantum, and surface the trap to main via `onError` channel。
      // Keep returning true so the AudioWorkletProcessor stays alive (=
      // node stays connected per docs/05-client.md §4)。
      state.failed = true;
      fillOutputsSilent(outputs);
      self.port.postMessage({
        kind: "error",
        code: "wasm-trap",
        message: errorMessage(err),
      });
      return true;
    }

    // Marshal outputs from linear memory ioScratch.outputs[port][channel]。
    const outputViews = state.outputViews;
    for (let portIdx = 0; portIdx < state.audioOutputs.length; portIdx++) {
      const decl = state.audioOutputs[portIdx]!;
      const portOutput = outputs[portIdx] ?? [];
      const portViews = outputViews[portIdx]!;
      for (let c = 0; c < decl.channels; c++) {
        const view = portViews[c]!;
        const dest = portOutput[c];
        if (dest) {
          dest.set(view);
        }
      }
    }

    // publish copy (= sub-phase 7.4)。 WASM publish scheduler が publishCounters
    // 内 version を 更 新 し た slot だ け 共 有 buffer に copy + lastVersion を update。
    // SAB mode は Atomics.store (= main 側 が Atomics.load で torn read 回 避)、
    // postMessage fallback は 直 接 view に write (= 後 続 commit で main 側 へ の
    // notify path を fill)。 version は 必 ず 最 後 に store = main 側 が 「version
    // 増 加 を 検 出 + value を read」 経 路 で consistent read 担 保。
    const sharedView = state.publishSharedView;
    if (sharedView !== null) {
      const slots = state.publishSlots;
      const lastVersions = state.lastVersions;
      const sharedViews = state.publishWasmSharedViews;
      const counterViews = state.publishWasmCounterViews;
      const isSab = state.transport === "sab";
      for (let i = 0; i < slots.length; i++) {
        const counterView = counterViews[i]!;
        const currentVersion = counterView[1]!;
        if (currentVersion !== lastVersions[i]) {
          const valueBits = sharedViews[i]![0]!;
          const sampleCounter = counterView[0]!;
          const slotIdx = i * 3;
          if (isSab) {
            Atomics.store(sharedView, slotIdx, valueBits);
            Atomics.store(sharedView, slotIdx + 1, sampleCounter);
            Atomics.store(sharedView, slotIdx + 2, currentVersion);
          } else {
            sharedView[slotIdx] = valueBits;
            sharedView[slotIdx + 1] = sampleCounter;
            sharedView[slotIdx + 2] = currentVersion;
          }
          lastVersions[i] = currentVersion;
        }
      }
    }

    return true;
  };

  return {
    initialize,
    process,
    parameterDescriptors,
    inputs: inputDescriptors,
    outputs: outputDescriptors,
    publishSlots,
    eventRings,
  };
}
