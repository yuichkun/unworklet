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
  MessageDeclAst,
  ParamDecl,
  StateDecl,
} from "./compile/ast.ts";
import { layout, type Layout } from "./compile/layout.ts";
import { SAMPLES_PER_BLOCK } from "./dsl/constants.ts";
import type {
  EventRingSlotDescriptor,
  MessageRingSlotDescriptor,
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
  /**
   * `message<T>` declaration 一 覧 (= sub-phase 7.7)。 declaration 順 で layout
   * の messageRings slot と zip。 worklet template が per-quantum 開 始 で SAB
   * ring → WASM ring に mirror する path で 参 照。
   */
  readonly messages: readonly MessageDeclAst[];
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
    messages: graph.declarations.filter((d): d is MessageDeclAst => d.kind === "message"),
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
   * event ring SAB copy meta (= sub-phase 7.6 commit 5c)。 main か ら hand さ れ た
   * eventRingsBuffer (= SAB or ArrayBuffer) + per-ring descriptor + per-ring SAB
   * 内 offset。 eventRingsWasmViews / SabViews = pre-bind し た Uint8Array view
   * (= per-quantum bulk copy で 毎 quantum alloc 回 避、 realtime safety)。
   * event ナ シ processor で は null + 空 配 列。
   */
  readonly eventRingsBuffer: SharedArrayBuffer | ArrayBuffer | null;
  readonly eventRings: readonly EventRingSlotDescriptor[];
  readonly eventRingSabOffsets: readonly number[];
  readonly eventRingsWasmViews: readonly Uint8Array[];
  readonly eventRingsSabViews: readonly Uint8Array[];
  /** Per-ring header (= head / tail / overflow) Int32Array view = SAB Atomics.store 用 */
  readonly eventRingsWasmHeaderViews: readonly Int32Array[];
  readonly eventRingsSabHeaderViews: readonly Int32Array[];
  /**
   * §4.3 content buffer の per-ring view (= typed-array field を 持 つ event の み
   * non-null、 ring index と zip)。 WASM = 読 取 source (= 両 transport)、 SAB =
   * mirror 先 (= SAB 時 の み)。
   */
  readonly eventContentWasmViews: ReadonlyArray<Uint8Array | null>;
  readonly eventContentSabViews: ReadonlyArray<Uint8Array | null>;
  /**
   * postMessage path 用 = 各 event ring で 「前 quantum 末 で main へ 送 信 済 み の
   * head 値」 / 「同 overflow 値」。 次 quantum で 「currentHead != lastSent」 ま
   * た は 「currentOverflow != lastSent」 が 検 出 し た 時 だ け diff を port.postMessage
   * で 配 送 (= 変 化 ナ シ quantum は skip)。 SAB path で は 参 照 し な い (= SAB
   * mirror copy だ け で main 側 が rAF polling で 直 接 観 測)。
   */
  readonly lastSentEventHeads: number[];
  readonly lastSentEventOverflows: number[];
  /**
   * message ring SAB ↔ WASM mirror meta (= sub-phase 7.7d)。 event ring と zip
   * pattern、 ま た push 方 向 が 逆 (= main → worklet) = process 開 始 で
   * SAB → WASM mirror (= main が push し た slot を WASM ring に bulk copy +
   * head を WASM ring に commit)、 drain 末 尾 で WASM tail を SAB tail に commit
   * (= main 側 で 「drain 済」 を 観 測)。
   */
  readonly messageRingsBuffer: SharedArrayBuffer | ArrayBuffer | null;
  readonly messageRings: readonly MessageRingSlotDescriptor[];
  readonly messageRingSabOffsets: readonly number[];
  readonly messageRingsWasmViews: readonly Uint8Array[];
  /**
   * postMessage inject path 用 = 各 message ring の WASM 内 region を 1 度 だ け
   * pre-bind し た DataView (= field 別 setInt32 用)。 process() で 毎 quantum
   * `new DataView(...)` す る と audio thread alloc に な る た め init で 確 保
   * (= `messageRingsWasmViews` と 同 region、 `00-foundations.md` §5.1)。
   */
  readonly messageRingsWasmDataViews: readonly DataView[];
  readonly messageRingsSabViews: readonly Uint8Array[];
  readonly messageRingsWasmHeaderViews: readonly Int32Array[];
  readonly messageRingsSabHeaderViews: readonly Int32Array[];
  /**
   * §5.2 variable-length content buffer の per-ring view (= typed-array field を
   * 持 つ message の み non-null、 ring index と zip)。 WASM = 書 き 込 み 先 (=
   * 両 transport)、 SAB = main が push 済 を mirror す る source (= SAB 時 の み)。
   */
  readonly messageContentWasmViews: ReadonlyArray<Uint8Array | null>;
  readonly messageContentSabViews: ReadonlyArray<Uint8Array | null>;
  /**
   * postMessage path 用 = 各 message ring の content region 書 き 込 み cursor (=
   * payload ご と に byteLen 分 進 め て wrap)。 SAB path は main 側 cursor を 使 う
   * (= worklet は 全 region mirror) た め 不 使 用。
   */
  readonly messageContentCursors: number[];
  /**
   * postMessage path 用 = main 側 が `port.postMessage({ kind: 'message',
   * ringIndex, payload })` で 送 信 し た payload を audio thread の port.onmessage
   * で 受 領 し て push す る 一 時 queue。 process 開 始 で WASM ring に inject +
   * drain (= SAB path で main → SAB → WASM mirror で 走 る path の 代 替)。
   * SAB path で は 使 用 し な い (= 空 配 列 の ま ま)。
   */
  readonly messageQueueMirrors: Array<Array<Record<string, unknown>>>;
  /**
   * postMessage path 用 = 各 message ring で 「前 quantum 末 で main へ 送 信 済 み の
   * overflow 値」。 WASM 内 で drop-oldest 発 動 し て overflowCount が 増 え た 場 合、
   * 次 quantum 末 で diff 検 出 + port.postMessage で main に 通 知 (= main 側
   * diagnostics.overflowCount() の mirror 元)。
   */
  readonly lastSentMessageOverflows: number[];
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
    /**
     * event ring buffer 用 共 有 buffer (= sub-phase 7.6 commit 5b)。 全 event ring
     * を 連 続 で 配 置 し た 1 SAB (= main で alloc)、 worklet template が
     * per-quantum 末 尾 で WASM ring → SAB ring に copy (= commit 5c で fill)。
     * event ナ シ processor で は hand さ れ な い。
     */
    eventRingsBuffer?: SharedArrayBuffer | ArrayBuffer;
    /**
     * event ring descriptor 配 列 (= declaration 順、 layout の eventRings slot と
     * zip)。 worklet template が WASM memory の どこ か ら read す る か を 各 ring
     * で 取 得 (= wasmRingBase / capacity / slotSize / fields)。
     */
    eventRings?: readonly EventRingSlotDescriptor[];
    /**
     * 各 event ring の SAB 内 offset (= declaration 順、 eventRings と zip)。
     * worklet template が per-ring の SAB 書 き 込 み base を 取 る path。
     */
    eventRingSabOffsets?: readonly number[];
    /**
     * §4.3 content buffer 用 SAB (= typed-array field を 持 つ event が あ る 時 の み、
     * SAB transport 限 定)。 worklet が WASM content region を ここ に mirror、 main が read。
     */
    eventContentBuffer?: SharedArrayBuffer | ArrayBuffer;
    /** 各 event ring の content SAB 内 offset (= ring index と zip)。 */
    eventContentSabOffsets?: readonly number[];
    /**
     * message ring buffer 用 共 有 buffer (= sub-phase 7.7d)。 全 message ring を
     * 連 続 で 配 置 し た 1 SAB (= main で alloc)、 main 側 が SAB に slot push +
     * worklet template が per-quantum 開 始 で SAB → WASM ring に mirror (= drain
     * は WASM 内 で 走 ら す path)。 message ナ シ processor は hand さ れ ない。
     */
    messageRingsBuffer?: SharedArrayBuffer | ArrayBuffer;
    /**
     * message ring descriptor 配 列 (= declaration 順、 layout の messageRings
     * slot と zip)。
     */
    messageRings?: readonly MessageRingSlotDescriptor[];
    /**
     * 各 message ring の SAB 内 offset (= declaration 順、 messageRings と zip)。
     */
    messageRingSabOffsets?: readonly number[];
    /**
     * §5.2 variable-length content buffer 用 SAB (= typed-array field を 持 つ
     * message が 1 つ で も あ る 時 の み hand、 SAB transport 限 定)。 全 content
     * ring を 連 続 配 置、 per-ring base は messageContentSabOffsets で 引 く。
     */
    messageContentBuffer?: SharedArrayBuffer | ArrayBuffer;
    /**
     * 各 message ring の content SAB 内 offset (= ring index と zip、 content ナ シ の
     * ring も 0 を hold = 使 用 側 は descriptor.payloadContent 有 無 で 判 断)。
     */
    messageContentSabOffsets?: readonly number[];
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
    // typed-array field あ り の event は §4.3 content buffer を 持 つ。 SAB content
    // region を mirror / 直 抽 出 す る 先 の WASM base + capacity を descriptor に。
    const content = lay.regions.payloadContent.slots[evt.name];
    return {
      name: evt.name,
      wasmRingBase: slot.base,
      capacity: slot.capacity,
      slotSize: slot.slotSize,
      fields: slot.fields,
      ...(content !== undefined
        ? { payloadContent: { wasmBase: content.base, capacity: content.capacity } }
        : {}),
    };
  });

  // messageRings = declaration 順 で per-message descriptor を 構 築 (= sub-phase 7.7d)。
  // createNode が messageRingsBuffer SAB allocate + worklet template が per-quantum
  // 開 始 で SAB → WASM mirror で 参 照。
  const messageRings: MessageRingSlotDescriptor[] = meta.messages.map((msg) => {
    const slot = lay.regions.messageRings.slots[msg.name];
    /* v8 ignore next 3 — message declaration が 既 capture 段 階 で layout に push
       済 = 構 造 上 unreachable defensive guard */
    if (slot === undefined) {
      throw new Error(`unworklet: missing layout slot for message "${msg.name}"`);
    }
    // typed-array field あ り の message は §5.2 content buffer を 持 つ (= layout の
    // payloadContent slot)。 transport が SAB content region を mirror / 直 書 き す る
    // 先 の WASM base + capacity を descriptor に 載 せ る。
    const content = lay.regions.payloadContent.slots[msg.name];
    return {
      name: msg.name,
      wasmRingBase: slot.base,
      capacity: slot.capacity,
      slotSize: slot.slotSize,
      fields: slot.fields,
      ...(content !== undefined
        ? { payloadContent: { wasmBase: content.base, capacity: content.capacity } }
        : {}),
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

      // event ring meta + buffer を opts か ら 取 り 出 し (= sub-phase 7.6 commit 5c)。
      // 各 ring で WASM memory 上 と SAB 上 の Uint8Array view を pre-bind し て
      // per-quantum 末 尾 で bulk copy + Atomics.store(head / overflow) で main 公 開。
      const eventRingsBuffer = opts.processorOptions?.eventRingsBuffer ?? null;
      const eventRings = opts.processorOptions?.eventRings ?? [];
      const eventRingSabOffsets = opts.processorOptions?.eventRingSabOffsets ?? [];
      // §4.3 content buffer (= typed-array field を 持 つ event の み)。 worklet が
      // WASM content region を SAB に mirror (= SAB) / payload に 抽 出 (= postMessage)。
      const eventContentBuffer = opts.processorOptions?.eventContentBuffer ?? null;
      const eventContentSabOffsets = opts.processorOptions?.eventContentSabOffsets ?? [];
      const eventRingsWasmViews: Uint8Array[] = [];
      const eventRingsSabViews: Uint8Array[] = [];
      const eventRingsWasmHeaderViews: Int32Array[] = [];
      const eventRingsSabHeaderViews: Int32Array[] = [];
      const eventContentWasmViews: Array<Uint8Array | null> = [];
      const eventContentSabViews: Array<Uint8Array | null> = [];
      // postMessage path 用 = 各 ring の 「前 quantum で 送 信 済 み head / overflow」
      // を track (= 次 quantum で diff だ け 送 る path)。 SAB path は 参 照 ナ シ で
      // 初 期 値 0 の ま ま。
      const lastSentEventHeads = eventRings.map(() => 0);
      const lastSentEventOverflows = eventRings.map(() => 0);
      // WASM views = 両 transport で 必 要 (= worklet が WASM 内 ring を 読 む path
      // は SAB / postMessage 共 通)。 SAB views = SAB 時 の み bind (= postMessage
      // path は eventRingsBuffer 不 在)。
      for (let i = 0; i < eventRings.length; i++) {
        const ring = eventRings[i]!;
        const ringTotalBytes = 12 + ring.capacity * ring.slotSize;
        eventRingsWasmViews.push(new Uint8Array(memory.buffer, ring.wasmRingBase, ringTotalBytes));
        eventRingsWasmHeaderViews.push(new Int32Array(memory.buffer, ring.wasmRingBase, 3));
        if (eventRingsBuffer !== null) {
          eventRingsSabViews.push(
            new Uint8Array(eventRingsBuffer, eventRingSabOffsets[i]!, ringTotalBytes),
          );
          eventRingsSabHeaderViews.push(
            new Int32Array(eventRingsBuffer, eventRingSabOffsets[i]!, 3),
          );
        }
        const content = ring.payloadContent;
        if (content !== undefined) {
          eventContentWasmViews.push(
            new Uint8Array(memory.buffer, content.wasmBase, content.capacity),
          );
          const sabOffset = eventContentSabOffsets[i];
          eventContentSabViews.push(
            eventContentBuffer !== null && sabOffset !== undefined
              ? new Uint8Array(eventContentBuffer, sabOffset, content.capacity)
              : null,
          );
        } else {
          eventContentWasmViews.push(null);
          eventContentSabViews.push(null);
        }
      }

      // message ring meta + buffer pre-bind。 event ring と zip pattern、 mirror
      // 方 向 が 逆 (= main → worklet)。 transport mode で 経 路 が 分 岐:
      //
      // - SAB available: main 側 が SAB に push + worklet 側 process 開 始 で SAB →
      //   WASM bulk copy + drain 末 尾 で WASM tail を SAB tail に commit
      // - SAB unavailable: 共 有 buffer 不 在、 main 側 が `port.postMessage({
      //   kind:'message', ringIndex, payload })` で 直 送 = worklet 側 が
      //   self.port.onmessage で 受 領 + messageQueueMirrors に push + process 開 始 で
      //   WASM ring に field 別 inject + WASM 内 overflowCount を 末 尾 で main に
      //   port.postMessage で 通 知 (= main mirror 更 新)。
      //
      // WASM views = 両 transport で 必 要 (= worklet が WASM 内 ring を 書 く)。
      // SAB views = SAB 時 の み bind。
      const messageRingsBuffer = opts.processorOptions?.messageRingsBuffer ?? null;
      const messageRings = opts.processorOptions?.messageRings ?? [];
      const messageRingSabOffsets = opts.processorOptions?.messageRingSabOffsets ?? [];
      // §5.2 variable-length content buffer (= typed-array field を 持 つ message の み)。
      // SAB 時 = main が content SAB に push 済 を per-quantum 先 頭 で WASM region に
      // mirror、 postMessage 時 = audio thread で payload の typed array を WASM region に
      // 直 書 き。 ring index と zip (= content ナ シ の ring は null)。
      const messageContentBuffer = opts.processorOptions?.messageContentBuffer ?? null;
      const messageContentSabOffsets = opts.processorOptions?.messageContentSabOffsets ?? [];
      const messageRingsWasmViews: Uint8Array[] = [];
      const messageRingsWasmDataViews: DataView[] = [];
      const messageRingsSabViews: Uint8Array[] = [];
      const messageRingsWasmHeaderViews: Int32Array[] = [];
      const messageRingsSabHeaderViews: Int32Array[] = [];
      const messageContentWasmViews: Array<Uint8Array | null> = [];
      const messageContentSabViews: Array<Uint8Array | null> = [];
      const messageContentCursors: number[] = messageRings.map(() => 0);
      const messageQueueMirrors: Array<Array<Record<string, unknown>>> = messageRings.map(() => []);
      const lastSentMessageOverflows = messageRings.map(() => 0);
      for (let i = 0; i < messageRings.length; i++) {
        const ring = messageRings[i]!;
        const ringTotalBytes = 12 + ring.capacity * ring.slotSize;
        messageRingsWasmViews.push(
          new Uint8Array(memory.buffer, ring.wasmRingBase, ringTotalBytes),
        );
        messageRingsWasmDataViews.push(
          new DataView(memory.buffer, ring.wasmRingBase, ringTotalBytes),
        );
        messageRingsWasmHeaderViews.push(new Int32Array(memory.buffer, ring.wasmRingBase, 3));
        if (messageRingsBuffer !== null) {
          messageRingsSabViews.push(
            new Uint8Array(messageRingsBuffer, messageRingSabOffsets[i]!, ringTotalBytes),
          );
          messageRingsSabHeaderViews.push(
            new Int32Array(messageRingsBuffer, messageRingSabOffsets[i]!, 3),
          );
        }
        const content = ring.payloadContent;
        if (content !== undefined) {
          messageContentWasmViews.push(
            new Uint8Array(memory.buffer, content.wasmBase, content.capacity),
          );
          const sabOffset = messageContentSabOffsets[i];
          messageContentSabViews.push(
            messageContentBuffer !== null && sabOffset !== undefined
              ? new Uint8Array(messageContentBuffer, sabOffset, content.capacity)
              : null,
          );
        } else {
          messageContentWasmViews.push(null);
          messageContentSabViews.push(null);
        }
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
        eventRingsBuffer,
        eventRings,
        eventRingSabOffsets,
        eventRingsWasmViews,
        eventRingsSabViews,
        eventRingsWasmHeaderViews,
        eventRingsSabHeaderViews,
        eventContentWasmViews,
        eventContentSabViews,
        lastSentEventHeads,
        lastSentEventOverflows,
        messageRingsBuffer,
        messageRings,
        messageRingSabOffsets,
        messageRingsWasmViews,
        messageRingsWasmDataViews,
        messageRingsSabViews,
        messageRingsWasmHeaderViews,
        messageRingsSabHeaderViews,
        messageContentWasmViews,
        messageContentSabViews,
        messageContentCursors,
        messageQueueMirrors,
        lastSentMessageOverflows,
        failed: false,
      };

      // postMessage path 用 incoming message listener (= main 側 sender が
      // `port.postMessage({ kind: 'message', ringIndex, payload })` で 送 信 す る を
      // audio thread 側 で receive、 messageQueueMirrors[i] に push し て 次 process
      // 開 始 で WASM ring に inject)。 SAB 時 は main 側 sender が SAB に 直 接 write
      // = listener は drop。
      const port = self.port as {
        addEventListener?: (kind: string, handler: (event: MessageEvent) => void) => void;
        start?: () => void;
      };
      if (typeof port.addEventListener === "function" && messageRings.length > 0) {
        port.addEventListener("message", (event: MessageEvent) => {
          const data = event.data as
            | { kind?: unknown; ringIndex?: unknown; payload?: unknown }
            | null
            | undefined;
          if (typeof data !== "object" || data === null) return;
          if (data.kind !== "message") return;
          if (typeof data.ringIndex !== "number") return;
          const ringIndex = data.ringIndex;
          if (ringIndex < 0 || ringIndex >= messageRings.length) return;
          if (typeof data.payload !== "object" || data.payload === null) return;
          // ingress を ring capacity で bound (= drop-oldest)。 main が 1 quantum 間 に
          // capacity 超 の burst を post し て も queue が 膨 ら ま ず、 process() の
          // `for (const payload of queue)` drain loop が audio thread で burst 比 例 =
          // unbounded loop に な ら な い (= `00-foundations.md` §5.1 invariant 2)。 drop
          // し た 分 は WASM ring overflow counter に 計 上 (= SAB path の ring drop-oldest
          // と 同 じ overflowCount semantics、 process 末 尾 で main に notify)。
          const queue = messageQueueMirrors[ringIndex]!;
          if (queue.length >= messageRings[ringIndex]!.capacity) {
            queue.shift();
            const wasmH = messageRingsWasmHeaderViews[ringIndex]!;
            wasmH[2] = wasmH[2]! + 1;
          }
          queue.push(data.payload as Record<string, unknown>);
        });
        // MessagePort spec = addEventListener 経 路 は implicit start し な い =
        // start() 明 示 で 受 信 を 有 効 化 (= onmessage = ... path は auto-start
        // だ が、 addEventListener path は 別 必 要)。
        if (typeof port.start === "function") {
          port.start();
        }
      }

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

    // message ring mirror = transport mode で 経 路 が 分 岐 (process 開 始 で WASM
    // ring に main 側 push 分 を inject + drain logic が WASM 内 で 走 る):
    //
    // - SAB available: main 側 が SAB に push 済 = header を Atomics.load で acquire
    //   し て か ら SAB → WASM bulk copy (= §5.5 acquire-before-read) + WASM ring 反 映。
    // - SAB unavailable: 共 有 buffer 不 在 = main 側 が port.postMessage で 直 送
    //   = messageQueueMirrors[i] に 蓄 積 済 = process 開 始 で 各 payload を WASM
    //   ring slot に field 別 inject + 容 量 超 え で drop-oldest 発 動 + 内 部
    //   overflowCount += 1 (= 末 尾 で main に 通 知)。
    if (state.messageRings.length > 0) {
      const isSab = state.transport === "sab";
      if (isSab && state.messageRingsBuffer !== null) {
        // SAB path = 既 SAB → WASM bulk copy + header mirror
        const wasmViews = state.messageRingsWasmViews;
        const sabViews = state.messageRingsSabViews;
        const wasmHeaders = state.messageRingsWasmHeaderViews;
        const sabHeaders = state.messageRingsSabHeaderViews;
        for (let i = 0; i < wasmViews.length; i++) {
          const sabH = sabHeaders[i]!;
          const wasmH = wasmHeaders[i]!;
          const prevHead = wasmH[0]!;
          // §5.5 consumer protocol: head を acquire-load し て か ら slot data を
          // copy す る。 producer (= main) は slot 書 き 込 み → release-store(head)
          // の 順 な の で、 acquire-load(head) が slot copy よ り 前 で あ れ ば
          // 「head が 観 測 し た 分 の slot bytes」 は happens-before で 可 視。
          // copy を acquire の 前 に 置 く と 並 行 producer write を torn read す る。
          wasmH[0] = Atomics.load(sabH, 0);
          wasmH[1] = Atomics.load(sabH, 1);
          wasmH[2] = Atomics.load(sabH, 2);
          wasmViews[i]!.set(sabViews[i]!);
          // typed-array field 持 ち の ring = head が 進 ん だ quantum だ け content
          // region 全 体 を SAB → WASM に mirror (= §5.2、 slot の payloadOffset は
          // region base 相 対 の 絶 対 index = full mirror で addressing 一 致)。 head
          // 不 変 な ら 新 規 payload ナ シ = 大 region memcpy を skip。
          const contentWasm = state.messageContentWasmViews[i];
          const contentSab = state.messageContentSabViews[i];
          if (contentWasm !== null && contentSab !== null && wasmH[0]! !== prevHead) {
            contentWasm.set(contentSab);
          }
        }
      } else {
        // postMessage path = messageQueueMirrors を WASM ring に inject
        for (let i = 0; i < state.messageRings.length; i++) {
          const queue = state.messageQueueMirrors[i]!;
          if (queue.length === 0) continue;
          const ring = state.messageRings[i]!;
          const wasmH = state.messageRingsWasmHeaderViews[i]!;
          // ring view は init で pre-bind 済 み を 使 い 回 す (= audio thread で の
          // per-quantum DataView alloc を 避 け る、 `00-foundations.md` §5.1)。
          const wasmDataView = state.messageRingsWasmDataViews[i]!;
          const capacity = ring.capacity;
          const slotSize = ring.slotSize;
          for (const payload of queue) {
            const head = wasmH[0]!;
            const tail = wasmH[1]!;
            // overflow check = head - tail >= capacity = drop-oldest
            if (head - tail >= capacity) {
              wasmH[1] = tail + 1;
              wasmH[2] = wasmH[2]! + 1;
            }
            // slot 書 き 込 み (= Q46 uniform lift で 全 number → i32 / boolean → 0/1 i32、
            // typed-array → §5.2 content region に bytes + slot に [payloadLen, payloadOffset])
            const slotByteOffset = 12 + (head % capacity) * slotSize;
            for (const field of ring.fields) {
              const value = payload[field.name];
              const byteOffset = slotByteOffset + field.offsetInSlot;
              if (field.payloadElementType !== undefined) {
                const contentWasm = state.messageContentWasmViews[i];
                if (contentWasm !== null && ArrayBuffer.isView(value)) {
                  // content region より大きい payload は truncate (= Q85: no-trap。
                  // clamp し な い と contentWasm.set が audio thread で RangeError を throw)。
                  const copyBytes = Math.min(value.byteLength, contentWasm.length);
                  const src = new Uint8Array(value.buffer, value.byteOffset, copyBytes);
                  let cursor = state.messageContentCursors[i]!;
                  // region 末 尾 を 跨 ぐ な ら 先 頭 に wrap (= drop-oldest)。
                  if (cursor + copyBytes > contentWasm.length) cursor = 0;
                  contentWasm.set(src, cursor);
                  wasmDataView.setUint32(byteOffset, copyBytes, true);
                  wasmDataView.setUint32(byteOffset + 4, cursor, true);
                  state.messageContentCursors[i] = cursor + copyBytes;
                }
              } else if (typeof value === "boolean") {
                wasmDataView.setInt32(byteOffset, value ? 1 : 0, true);
              } else if (typeof value === "number") {
                wasmDataView.setInt32(byteOffset, value | 0, true);
              }
            }
            wasmH[0] = head + 1;
          }
          queue.length = 0;
        }
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

    // publish copy (= sub-phase 7.4 + postMessage path fix)。 WASM publish
    // scheduler が publishCounters 内 version を 更 新 し た slot だ け 走 査 し て
    // 版 advance 時 に main 側 に 値 を 配 達 す る。 transport mode で 経 路 が 分 岐:
    //
    // - SAB available: 共 有 SAB を Atomics.store で 更 新 (= main 側 が rAF polling
    //   + Atomics.load で torn read 回 避 + version advance を 検 出 し て dispatch)。
    // - SAB unavailable: 共 有 buffer は 不 在 (= structured clone で main / worklet
    //   が 別 instance を 持 つ た め mirror 不 能) = port.postMessage で main へ
    //   個 別 通 知。 main 側 は port.onmessage で 即 時 mirror state 更 新 + subscriber
    //   dispatch (= rAF polling 不 要 = `02-messaging.md` §4 / `04-worklet-runtime.md`
    //   §7 通 り)。
    //
    // 版 advance チェック を 共 通 化 し た 上 で、 配 達 経 路 だ け 分 岐。
    const slots = state.publishSlots;
    const lastVersions = state.lastVersions;
    const sharedViews = state.publishWasmSharedViews;
    const counterViews = state.publishWasmCounterViews;
    const isSab = state.transport === "sab";
    const sharedView = state.publishSharedView;
    for (let i = 0; i < slots.length; i++) {
      const counterView = counterViews[i]!;
      const currentVersion = counterView[1]!;
      if (currentVersion !== lastVersions[i]) {
        const valueBits = sharedViews[i]![0]!;
        const sampleCounter = counterView[0]!;
        if (isSab && sharedView !== null) {
          const slotIdx = i * 3;
          Atomics.store(sharedView, slotIdx, valueBits);
          Atomics.store(sharedView, slotIdx + 1, sampleCounter);
          Atomics.store(sharedView, slotIdx + 2, currentVersion);
        } else {
          // postMessage path = main 側 へ flag-bearing 通 知。 slotIndex で 識 別、
          // valueBits は publish 値 を i32 bit pattern と し て carry (= main 側 で
          // 型 別 reinterpret)、 sampleCounter は diagnostics 用、 version は
          // main local lastSeenVersion 比 較 の anchor。
          self.port.postMessage({
            kind: "publish",
            slotIndex: i,
            valueBits,
            sampleCounter,
            version: currentVersion,
          });
        }
        lastVersions[i] = currentVersion;
      }
    }

    // event ring copy = transport mode で 経 路 が 分 岐:
    //
    // - SAB available: 既 SAB bulk copy (= ring 全 体 を SAB に mirror) + header
    //   Atomics.store (= main 側 が rAF polling + Atomics.load で head release
    //   fence を 取 っ て slot 列 visibility 担 保)。
    // - SAB unavailable: 共 有 buffer 不 在 (= structured clone で main / worklet が
    //   別 ring instance) = 新 emit 分 (= lastSentHead .. currentHead) を Uint8Array
    //   slice で 抽 出 + port.postMessage で 配 送 (= main 側 onEventMessage で payload
    //   object 化 + subscriber dispatch、 overflowCount は payload に carry し て
    //   main mirror を 更 新)。 変 化 ナ シ quantum は skip。
    //
    // 注: postMessage path で per-quantum `new Uint8Array(...)` alloc は 02-messaging
    // §4 の 「pre-allocated transferable buffers + ownership transfer」 ping-pong
    // path に v1.0.0 ship 前 に refactor 予 定 (= 当 wave は「動 く」 まで)。
    if (state.eventRings.length > 0) {
      const wasmViews = state.eventRingsWasmViews;
      const sabViews = state.eventRingsSabViews;
      const wasmHeaders = state.eventRingsWasmHeaderViews;
      const sabHeaders = state.eventRingsSabHeaderViews;
      const isSab = state.transport === "sab";
      for (let i = 0; i < state.eventRings.length; i++) {
        const ring = state.eventRings[i]!;
        const wasmH = wasmHeaders[i]!;
        const currentHead = wasmH[0]!;
        const currentTail = wasmH[1]!;
        const currentOverflow = wasmH[2]!;
        if (isSab && state.eventRingsBuffer !== null) {
          // SAB path = 既 bulk copy + header Atomics.store
          sabViews[i]!.set(wasmViews[i]!);
          // §4.3 typed-array field 持 ち = content region を WASM → SAB に mirror
          // (= head Atomics.store 前 = release fence で main が slot 越 し に 観 測 可)。
          const contentWasm = state.eventContentWasmViews[i];
          const contentSab = state.eventContentSabViews[i];
          if (contentWasm !== null && contentSab !== null) {
            contentSab.set(contentWasm);
          }
          const sabH = sabHeaders[i]!;
          Atomics.store(sabH, 0, currentHead);
          Atomics.store(sabH, 1, currentTail);
          Atomics.store(sabH, 2, currentOverflow);
        } else {
          // postMessage path = 新 emit 分 を 抽 出 + port.postMessage 配 送
          const lastSentHead = state.lastSentEventHeads[i]!;
          const lastSentOverflow = state.lastSentEventOverflows[i]!;
          if (currentHead === lastSentHead && currentOverflow === lastSentOverflow) continue;
          // drop-oldest 発 動 で tail が lastSentHead を 越 え て いる 可 能 性 = max
          // で 巻 き 直 し (= 古 い slot は overflow 済 で 飛 ば す)。
          const from = lastSentHead < currentTail ? currentTail : lastSentHead;
          const newSlotCount = currentHead - from;
          const slotSize = ring.slotSize;
          const capacity = ring.capacity;
          const wasmRawView = wasmViews[i]!;
          // 新 slot 群 を Uint8Array に bulk copy (= main 側 で field 解 読)
          const slotsBytes = new Uint8Array(newSlotCount * slotSize);
          for (let k = 0; k < newSlotCount; k++) {
            const slotIdx = (from + k) % capacity;
            const srcOffset = 12 + slotIdx * slotSize;
            slotsBytes.set(wasmRawView.subarray(srcOffset, srcOffset + slotSize), k * slotSize);
          }
          const eventMsg: {
            kind: "event";
            ringIndex: number;
            newSlotsBytes: ArrayBuffer;
            newSlotCount: number;
            overflowCount: number;
            contentBytes?: ArrayBuffer;
          } = {
            kind: "event",
            ringIndex: i,
            newSlotsBytes: slotsBytes.buffer,
            newSlotCount,
            overflowCount: currentOverflow,
          };
          // §4.3 typed-array field 持 ち = content region snapshot を 同 梱 (= main は
          // WASM memory に 触 れ な い = slot の payloadOffset/Len で ここ か ら slice)。
          const contentWasm = state.eventContentWasmViews[i];
          if (contentWasm !== null) {
            eventMsg.contentBytes = contentWasm.slice().buffer;
          }
          self.port.postMessage(eventMsg);
          state.lastSentEventHeads[i] = currentHead;
          state.lastSentEventOverflows[i] = currentOverflow;
        }
      }
    }

    // message ring tail commit / overflow notify = transport mode で 経 路 が 分 岐:
    //
    // - SAB available: WASM drain で 進 ん だ tail を SAB に commit (= main 側 が
    //   SAB tail を Atomics.load で 「drain 済 ま で」 観 測 可)。
    // - SAB unavailable: WASM 内 で drop-oldest 発 動 し た 場 合 = overflowCount が
    //   変 化 し て いる = main に port.postMessage で 通 知 (= main 側 messageOverflowMirror
    //   が 更 新 + diagnostics.overflowCount() で read 可)。 tail commit は 不 要
    //   (= main 側 mirror 無 い path = SAB tail 観 測 ナ シ)。
    if (state.messageRings.length > 0) {
      const isSab = state.transport === "sab";
      const wasmHeaders = state.messageRingsWasmHeaderViews;
      if (isSab && state.messageRingsBuffer !== null) {
        const sabHeaders = state.messageRingsSabHeaderViews;
        for (let i = 0; i < wasmHeaders.length; i++) {
          const wasmH = wasmHeaders[i]!;
          const sabH = sabHeaders[i]!;
          Atomics.store(sabH, 1, wasmH[1]!);
        }
      } else {
        for (let i = 0; i < wasmHeaders.length; i++) {
          const wasmH = wasmHeaders[i]!;
          const currentOverflow = wasmH[2]!;
          if (currentOverflow !== state.lastSentMessageOverflows[i]) {
            self.port.postMessage({
              kind: "message-overflow",
              ringIndex: i,
              overflowCount: currentOverflow,
            });
            state.lastSentMessageOverflows[i] = currentOverflow;
          }
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
    messageRings,
  };
}
