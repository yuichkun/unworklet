// WASM emission via binaryen.js. Walks the captured AST, emits a binaryen
// Module, returns the compiled binary + metadata for the worklet host.

import binaryen from "binaryen";
import type {
  ASTValue,
  CapturedGraph,
  Statement,
  ScalarType,
  AnyType,
} from "./ast.js";
import type { MemoryLayout } from "./memory-layout.js";

type ExprRef = number; // binaryen.ExpressionRef
type FuncRef = number;
type Type = number;

// Map our scalar types to binaryen types.
function bType(t: AnyType): Type {
  switch (t) {
    case "f32":
      return binaryen.f32;
    case "f64":
      return binaryen.f64;
    case "i32":
      return binaryen.i32;
    case "i64":
      return binaryen.i64;
    case "bool":
      return binaryen.i32;
    case "f32x4":
      return binaryen.v128;
  }
}

function elemSize(t: ScalarType): number {
  return t === "f32" ? 4 : t === "i32" ? 4 : t === "f64" ? 8 : t === "i64" ? 8 : 4;
}

class Emit {
  m: binaryen.Module;
  layout: MemoryLayout;
  graph: CapturedGraph;

  // Per-emission state
  // Local variable counter and binaryen local types for the current function
  localTypes: Type[] = [];
  // Stack of loop var local indices, indexed by depth
  loopVarLocals: number[] = [];
  // Math import names (resolved on import section).
  mathImports: Map<string, FuncRef> = new Map();
  // The single sample-counter local index inside `process`.
  sampleCounterLocal = -1;
  // Persistent absolute sample counter slot (in linear memory at this offset)
  absoluteSampleCounterOffset: number;

  constructor(graph: CapturedGraph, layout: MemoryLayout) {
    this.graph = graph;
    this.layout = layout;
    this.m = new binaryen.Module();
    this.m.setFeatures(
      binaryen.Features.SIMD128 |
        binaryen.Features.BulkMemory |
        binaryen.Features.BulkMemoryOpt |
        binaryen.Features.SignExt |
        binaryen.Features.MutableGlobals |
        binaryen.Features.NontrappingFPToInt,
    );

    // The absolute sample counter sits in a fixed location in state region
    // — actually let's put it at the very beginning of memory (offset 0 is
    // fine because state region begins after).
    // Simpler: put it AFTER all the layout regions, in a small "scratch"
    // section. We extend the layout by 8 bytes here.
    this.absoluteSampleCounterOffset = layout.totalBytes;
    // Extend memory if needed.
    const extended = layout.totalBytes + 8;
    const PAGE = 64 * 1024;
    if (extended > layout.initialPages * PAGE) {
      layout.initialPages = Math.ceil(extended / PAGE);
    }
    layout.totalBytes = extended;
  }

  // ─── Top-level: build the module ────────────────────────────────────────

  build(): { binary: Uint8Array; text: string; layout: MemoryLayout } {
    const m = this.m;
    // Create memory; export it so the host can read/write directly.
    m.setMemory(this.layout.initialPages, this.layout.initialPages, "memory");

    // Math imports
    this.declareMathImports();

    // Build the `process` function
    this.buildProcess();

    // Build per-message handler functions
    this.buildMessageHandlers();

    // Build per-MIDI handler functions
    this.buildMidiHandlers();

    // Build a `init` function that zero-initializes state region with declared
    // initial values + sets buffer regions to zero (already zero by default).
    this.buildInit();

    if (!m.validate()) {
      const text = m.emitText();
      throw new Error("WASM module validation failed:\n" + text);
    }

    const binary = m.emitBinary();
    const text = m.emitText();
    return { binary, text, layout: this.layout };
  }

  declareMathImports() {
    // We import Math.sin, Math.cos, etc. as f64 -> f64 functions and convert
    // f32 ↔ f64 at the boundary.
    const fns = ["sin", "cos", "tan", "tanh", "exp", "log", "pow", "atan2"];
    for (const fn of fns) {
      this.m.addFunctionImport(
        `math_${fn}`,
        "math",
        fn,
        binaryen.createType([binaryen.f64]),
        binaryen.f64,
      );
    }
  }

  // ─── init() ─────────────────────────────────────────────────────────────

  buildInit() {
    const m = this.m;
    const stmts: ExprRef[] = [];
    // Zero memory? memory.fill is fine.
    stmts.push(
      m.memory.fill(
        m.i32.const(0),
        m.i32.const(0),
        m.i32.const(this.layout.totalBytes),
      ),
    );
    // Set state slot initial values.
    for (const slot of this.layout.stateRegion.slots) {
      const s = this.graph.declarations.states.find((x) => x.id === slot.slotId);
      if (!s) continue;
      stmts.push(this.storeStateLayout(slot.offset, slot.type, this.constExpr(s.initial, slot.type)));
    }
    m.addFunction("init", binaryen.none, binaryen.none, [], m.block(null, stmts));
    m.addFunctionExport("init", "init");
  }

  constExpr(v: number | boolean, t: ScalarType): ExprRef {
    const m = this.m;
    if (t === "f32") return m.f32.const(typeof v === "boolean" ? (v ? 1 : 0) : v);
    if (t === "f64") return m.f64.const(typeof v === "boolean" ? (v ? 1 : 0) : v);
    if (t === "i32") return m.i32.const(typeof v === "boolean" ? (v ? 1 : 0) : (v as number) | 0);
    if (t === "i64") return m.i64.const(Number(v) & 0xffffffff, Math.floor(Number(v) / 0x100000000));
    return m.i32.const(v ? 1 : 0); // bool
  }

  storeStateLayout(offset: number, t: ScalarType, value: ExprRef): ExprRef {
    const m = this.m;
    if (t === "f32") return m.f32.store(0, 4, m.i32.const(offset), value);
    if (t === "f64") return m.f64.store(0, 8, m.i32.const(offset), value);
    if (t === "i32" || t === "bool") return m.i32.store(0, 4, m.i32.const(offset), value);
    return m.i64.store(0, 8, m.i32.const(offset), value);
  }
  loadStateLayout(offset: number, t: ScalarType): ExprRef {
    const m = this.m;
    if (t === "f32") return m.f32.load(0, 4, m.i32.const(offset));
    if (t === "f64") return m.f64.load(0, 8, m.i32.const(offset));
    if (t === "i32" || t === "bool") return m.i32.load(0, 4, m.i32.const(offset));
    return m.i64.load(0, 8, m.i32.const(offset));
  }

  // ─── process() ──────────────────────────────────────────────────────────

  // process(blockSize: i32) -> void
  // The host writes inputs/params into the I/O scratch BEFORE calling process,
  // and reads outputs AFTER. The host also dispatches messages/MIDI by writing
  // them into ring buffers before process; process drains them at the start.
  buildProcess() {
    const m = this.m;
    this.localTypes = [];
    this.loopVarLocals = [];
    // Local 0: blockSize: i32 (function parameter)
    // We don't allocate it as a "local" — params count as locals 0..N
    // before the explicit locals.

    // For each forSample, we'll add an i32 loop-counter local on demand.

    const stmts: ExprRef[] = [];

    // Drain message handlers, then MIDI handlers.
    // We dispatch them BEFORE forSample bodies run. The handler runs at
    // block start; sample-position primitives are not in scope (no `i`).
    stmts.push(this.emitMessageDrain());
    stmts.push(this.emitMidiDrain());

    // Reset event ring buffers? No — they're consumed by main reader; we
    // just write sample-accurate events as forSample iterates, per spec.

    // Emit process body statements.
    for (const s of this.graph.processBody) {
      stmts.push(this.emitStmt(s));
    }

    // Advance absolute sample counter.
    stmts.push(
      m.i32.store(
        0, 4,
        m.i32.const(this.absoluteSampleCounterOffset),
        m.i32.add(
          m.i32.load(0, 4, m.i32.const(this.absoluteSampleCounterOffset)),
          m.local.get(0, binaryen.i32),
        ),
      ),
    );

    // Build locals types array
    m.addFunction(
      "process",
      binaryen.createType([binaryen.i32]), // (blockSize: i32)
      binaryen.none,
      this.localTypes,
      m.block(null, stmts),
    );
    m.addFunctionExport("process", "process");
  }

  // Generate the message-drain code: for each message, walk head..tail and
  // dispatch via the message handler function.
  emitMessageDrain(): ExprRef {
    const m = this.m;
    const blocks: ExprRef[] = [];
    for (const ml of this.layout.messages.layouts) {
      const handler = this.graph.messageHandlers.find((h) => h.messageId === ml.messageId);
      if (!handler) continue;
      // while (head != tail) { call handler(slotPtr); tail = (tail+1) % cap }
      const headOff = ml.headerOffset + 0;
      const tailOff = ml.headerOffset + 4;
      // Loop: read head & tail; compare; dispatch
      const loopName = `msg_drain_${ml.messageId}`;
      const breakName = `msg_drain_break_${ml.messageId}`;
      const loadHead = m.i32.load(0, 4, m.i32.const(headOff));
      const loadTail = m.i32.load(0, 4, m.i32.const(tailOff));
      // slot ptr = slotsOffset + (tail % cap) * slotSize
      const slotIdx = m.i32.rem_u(loadTail, m.i32.const(ml.capacity));
      const slotPtr = m.i32.add(m.i32.const(ml.slotsOffset), m.i32.mul(slotIdx, m.i32.const(ml.slotSize)));
      // Dispatch handler. Handler signature: (slotPtr: i32) -> void
      const callHandler = m.call(`msgHandler_${ml.messageId}`, [slotPtr], binaryen.none);
      // Increment tail
      const incTail = m.i32.store(0, 4, m.i32.const(tailOff), m.i32.add(loadTail, m.i32.const(1)));
      blocks.push(
        m.loop(
          loopName,
          m.block(null, [
            m.if(
              m.i32.eq(loadHead, m.i32.load(0, 4, m.i32.const(tailOff))),
              m.br(breakName),
              m.block(null, [callHandler, incTail, m.br(loopName)]),
            ),
          ]),
        ),
      );
      // Wrap with break
      blocks[blocks.length - 1] = m.block(breakName, [blocks[blocks.length - 1]!]);
    }
    return m.block(null, blocks);
  }

  emitMidiDrain(): ExprRef {
    const m = this.m;
    const blocks: ExprRef[] = [];
    // For each MIDI input, drain its ring and dispatch to the corresponding
    // type-specific handler based on status byte.
    for (const ml of this.layout.midiInputs.layouts) {
      const handlersByType = this.graph.midiHandlers.filter(
        (h) => h.midiInputId === ml.midiId,
      );
      if (handlersByType.length === 0) continue;
      const headOff = ml.headerOffset + 0;
      const tailOff = ml.headerOffset + 4;
      const loopName = `midi_drain_${ml.midiId}`;
      const breakName = `midi_drain_break_${ml.midiId}`;
      const loadHead = m.i32.load(0, 4, m.i32.const(headOff));
      const loadTail = m.i32.load(0, 4, m.i32.const(tailOff));
      const slotIdx = m.i32.rem_u(loadTail, m.i32.const(ml.capacity));
      const slotPtr = m.i32.add(m.i32.const(ml.slotsOffset), m.i32.mul(slotIdx, m.i32.const(8)));
      // Dispatch by status byte (high nibble)
      const statusByte = m.i32.load8_u(0, 1, slotPtr);
      const high = m.i32.and(statusByte, m.i32.const(0xf0));
      const dispatchStmts: ExprRef[] = [];
      // Build an if-chain by status nibble
      let chain: ExprRef = m.nop();
      const buildCall = (eventType: string) => {
        return m.call(`midiHandler_${ml.midiId}_${eventType}`, [slotPtr], binaryen.none);
      };
      const known = new Set(handlersByType.map((h) => h.eventType));
      // 0x80 noteOff, 0x90 noteOn (vel=0 → noteOff per convention), 0xa0 aftertouch,
      // 0xb0 cc, 0xc0 programChange, 0xd0 channelPressure, 0xe0 pitchBend
      const cases: Array<[number, string]> = [
        [0x80, "noteOff"],
        [0x90, "noteOn"],
        [0xa0, "aftertouch"],
        [0xb0, "cc"],
        [0xc0, "programChange"],
        [0xd0, "channelPressure"],
        [0xe0, "pitchBend"],
      ];
      for (const [code, type] of cases) {
        if (!known.has(type)) continue;
        chain = m.if(m.i32.eq(high, m.i32.const(code)), buildCall(type), chain);
      }
      // System realtime detection (status >= 0xf8 && <= 0xfc)
      if (known.has("systemRealtime")) {
        chain = m.if(
          m.i32.and(
            m.i32.ge_u(statusByte, m.i32.const(0xf8)),
            m.i32.le_u(statusByte, m.i32.const(0xfc)),
          ),
          buildCall("systemRealtime"),
          chain,
        );
      }
      // Special-case: noteOn with velocity=0 -> noteOff
      if (known.has("noteOff") && known.has("noteOn")) {
        const data2 = m.i32.load8_u(0, 1, m.i32.add(slotPtr, m.i32.const(2)));
        chain = m.if(
          m.i32.and(
            m.i32.eq(high, m.i32.const(0x90)),
            m.i32.eq(data2, m.i32.const(0)),
          ),
          buildCall("noteOff"),
          chain,
        );
      }
      const incTail = m.i32.store(0, 4, m.i32.const(tailOff), m.i32.add(loadTail, m.i32.const(1)));
      blocks.push(
        m.block(breakName, [
          m.loop(
            loopName,
            m.block(null, [
              m.if(
                m.i32.eq(loadHead, m.i32.load(0, 4, m.i32.const(tailOff))),
                m.br(breakName),
                m.block(null, [chain, incTail, m.br(loopName)]),
              ),
            ]),
          ),
        ]),
      );
    }
    return m.block(null, blocks);
  }

  // ─── Statement emission ──────────────────────────────────────────────────

  emitStmt(s: Statement): ExprRef {
    const m = this.m;
    switch (s.kind) {
      case "state-store": {
        const slot = this.layout.stateRegion.slots.find((x) => x.slotId === s.slotId)!;
        const v = this.emitValue(s.value, slot.type);
        return this.storeStateLayout(slot.offset, slot.type, v);
      }
      case "buffer-write": {
        const buf = this.layout.bufferRegion.buffers.find((b) => b.bufferId === s.bufferId)!;
        const idx = this.emitValue(s.idx, "i32");
        const wrappedIdx = this.wrapIndex(idx, buf.size);
        const ptr = m.i32.add(
          m.i32.const(buf.offset),
          m.i32.mul(wrappedIdx, m.i32.const(elemSize(buf.type))),
        );
        const v = this.emitValue(s.value, buf.type);
        if (buf.type === "f32") return m.f32.store(0, 4, ptr, v);
        if (buf.type === "i32") return m.i32.store(0, 4, ptr, v);
        return m.f64.store(0, 8, ptr, v);
      }
      case "buffer-store-vec": {
        const buf = this.layout.bufferRegion.buffers.find((b) => b.bufferId === s.bufferId)!;
        if (buf.type !== "f32") throw new Error("buffer-store-vec on non-f32 buffer");
        const off = this.emitValue(s.offset, "i32");
        // Wrap offset within buffer size (no overflow into next region)
        const wrapped = this.wrapIndex(off, buf.size);
        const ptr = m.i32.add(m.i32.const(buf.offset), m.i32.mul(wrapped, m.i32.const(4)));
        return m.v128.store(0, 16, ptr, this.emitValue(s.value, "f32x4"));
      }
      case "audio-out-set": {
        const out = this.layout.audioOutputs.outputs.find((o) => o.outputId === s.outputId)!;
        const i = this.emitValue(s.i, "i32");
        const channelOffset = m.i32.add(
          m.i32.const(out.offset + s.channel * out.channelStride),
          m.i32.mul(i, m.i32.const(4)),
        );
        return m.f32.store(0, 4, channelOffset, this.emitValue(s.value, "f32"));
      }
      case "for-sample": {
        // Loop: for (let i = 0; i < blockSize; i += stride) { body }
        // i is a fresh local
        const iLocal = this.localTypes.length + 1; // +1 for the blockSize parameter
        this.localTypes.push(binaryen.i32);
        this.loopVarLocals.push(iLocal);
        try {
          const initI = m.local.set(iLocal, m.i32.const(0));
          const loopName = `forsample_${iLocal}`;
          const breakName = `forsample_break_${iLocal}`;
          const cond = m.i32.lt_s(m.local.get(iLocal, binaryen.i32), m.local.get(0, binaryen.i32));
          const bodyStmts = s.body.map((bs) => this.emitStmt(bs));
          const incI = m.local.set(
            iLocal,
            m.i32.add(m.local.get(iLocal, binaryen.i32), m.i32.const(s.stride)),
          );
          return m.block(null, [
            initI,
            m.block(breakName, [
              m.loop(
                loopName,
                m.block(null, [
                  m.if(m.i32.eqz(cond), m.br(breakName), m.nop()),
                  ...bodyStmts,
                  incI,
                  m.br(loopName),
                ]),
              ),
            ]),
          ]);
        } finally {
          this.loopVarLocals.pop();
        }
      }
      case "every-n-samples": {
        // ((absSampleCounter + i) % N) == 0 → execute body
        const i = this.loopVarLocals[this.loopVarLocals.length - 1];
        if (i === undefined) {
          throw new Error("everyNSamples used outside a forSample callback");
        }
        const absLoad = m.i32.load(0, 4, m.i32.const(this.absoluteSampleCounterOffset));
        const sum = m.i32.add(absLoad, m.local.get(i, binaryen.i32));
        const modOk = m.i32.eq(m.i32.rem_u(sum, m.i32.const(s.N)), m.i32.const(0));
        const bodyStmts = s.body.map((bs) => this.emitStmt(bs));
        return m.if(modOk, m.block(null, bodyStmts), m.nop());
      }
      case "emit-if": {
        const ev = this.layout.events.layouts.find((e) => e.eventId === s.eventId)!;
        // if (cond) { write slot at head; advance head; if overflow, drop oldest }
        const headOff = ev.headerOffset + 0;
        const tailOff = ev.headerOffset + 4;
        const overflowOff = ev.headerOffset + 8;
        const loadHead = m.i32.load(0, 4, m.i32.const(headOff));
        const loadTail = m.i32.load(0, 4, m.i32.const(tailOff));
        const slotIdx = m.i32.rem_u(loadHead, m.i32.const(ev.capacity));
        const slotPtr = m.i32.add(
          m.i32.const(ev.slotsOffset),
          m.i32.mul(slotIdx, m.i32.const(ev.slotSize)),
        );
        const writes: ExprRef[] = [];
        // atSample at offset 0
        writes.push(m.i32.store(0, 4, slotPtr, this.emitValue(s.atSample, "i32")));
        for (const f of s.fields) {
          const fl = ev.fieldOffsets[f.name];
          if (!fl) continue;
          const ptr = m.i32.add(slotPtr, m.i32.const(fl.offset));
          if (fl.type === "f32")
            writes.push(m.f32.store(0, 4, ptr, this.emitValue(f.value, "f32")));
          else if (fl.type === "i32" || fl.type === "bool")
            writes.push(m.i32.store(0, 4, ptr, this.emitValue(f.value, "i32")));
          else if (fl.type === "f64")
            writes.push(m.f64.store(0, 8, ptr, this.emitValue(f.value, "f64")));
        }
        // Drop-oldest: if head + 1 - tail >= capacity, increment overflow + tail
        const incHead = m.i32.store(0, 4, m.i32.const(headOff), m.i32.add(loadHead, m.i32.const(1)));
        const fullCheck = m.if(
          m.i32.ge_u(
            m.i32.sub(m.i32.add(loadHead, m.i32.const(1)), loadTail),
            m.i32.const(ev.capacity),
          ),
          m.block(null, [
            m.i32.store(
              0, 4,
              m.i32.const(overflowOff),
              m.i32.add(m.i32.load(0, 4, m.i32.const(overflowOff)), m.i32.const(1)),
            ),
            m.i32.store(0, 4, m.i32.const(tailOff), m.i32.add(loadTail, m.i32.const(1))),
          ]),
          m.nop(),
        );
        return m.if(
          this.emitValue(s.cond, "bool"),
          m.block(null, [...writes, fullCheck, incHead]),
          m.nop(),
        );
      }
      case "midi-emit-if": {
        const ml = this.layout.midiOutputs.layouts.find((x) => x.midiId === s.midiOutputId)!;
        const headOff = ml.headerOffset + 0;
        const tailOff = ml.headerOffset + 4;
        const overflowOff = ml.headerOffset + 8;
        const loadHead = m.i32.load(0, 4, m.i32.const(headOff));
        const loadTail = m.i32.load(0, 4, m.i32.const(tailOff));
        const slotIdx = m.i32.rem_u(loadHead, m.i32.const(ml.capacity));
        const slotPtr = m.i32.add(
          m.i32.const(ml.slotsOffset),
          m.i32.mul(slotIdx, m.i32.const(8)),
        );
        const writes = [
          m.i32.store8(0, 1, slotPtr, this.emitValue(s.status, "i32")),
          m.i32.store8(0, 1, m.i32.add(slotPtr, m.i32.const(1)), this.emitValue(s.data1, "i32")),
          m.i32.store8(0, 1, m.i32.add(slotPtr, m.i32.const(2)), this.emitValue(s.data2, "i32")),
          m.i32.store(0, 4, m.i32.add(slotPtr, m.i32.const(4)), this.emitValue(s.atSample, "i32")),
        ];
        const incHead = m.i32.store(0, 4, m.i32.const(headOff), m.i32.add(loadHead, m.i32.const(1)));
        const fullCheck = m.if(
          m.i32.ge_u(
            m.i32.sub(m.i32.add(loadHead, m.i32.const(1)), loadTail),
            m.i32.const(ml.capacity),
          ),
          m.block(null, [
            m.i32.store(
              0, 4,
              m.i32.const(overflowOff),
              m.i32.add(m.i32.load(0, 4, m.i32.const(overflowOff)), m.i32.const(1)),
            ),
            m.i32.store(0, 4, m.i32.const(tailOff), m.i32.add(loadTail, m.i32.const(1))),
          ]),
          m.nop(),
        );
        return m.if(
          this.emitValue(s.cond, "bool"),
          m.block(null, [...writes, fullCheck, incHead]),
          m.nop(),
        );
      }
    }
    throw new Error(`unhandled stmt kind ${(s as any).kind}`);
  }

  // ─── Value emission ──────────────────────────────────────────────────────

  emitValue(v: ASTValue, expectedType?: AnyType): ExprRef {
    const m = this.m;
    let result: ExprRef;
    let actualType: AnyType = v.type;

    switch (v.kind) {
      case "const": {
        result = this.constExpr(v.value, v.type as ScalarType);
        break;
      }
      case "instance-const": {
        if (v.source === "sampleRate") {
          // sampleRate is f32 typically
          result = this.constExpr(this.layout.renderQuantum, v.type as ScalarType);
        } else {
          result = this.constExpr(this.layout.renderQuantum, v.type as ScalarType);
        }
        break;
      }
      case "loop-var": {
        const local = this.loopVarLocals[v.depth];
        if (local === undefined) throw new Error(`loop-var at depth ${v.depth} not in scope`);
        result = m.local.get(local, binaryen.i32);
        actualType = "i32";
        break;
      }
      case "arith":
        result = this.emitArith(v);
        break;
      case "compare":
        result = this.emitCompare(v);
        break;
      case "logic": {
        if (v.op === "not") {
          result = m.i32.eqz(this.emitValue(v.args[0]!, "bool"));
        } else if (v.op === "and") {
          result = m.i32.and(
            m.i32.ne(this.emitValue(v.args[0]!, "bool"), m.i32.const(0)),
            m.i32.ne(this.emitValue(v.args[1]!, "bool"), m.i32.const(0)),
          );
        } else {
          result = m.i32.or(
            m.i32.ne(this.emitValue(v.args[0]!, "bool"), m.i32.const(0)),
            m.i32.ne(this.emitValue(v.args[1]!, "bool"), m.i32.const(0)),
          );
        }
        actualType = "bool";
        break;
      }
      case "math": {
        result = this.emitMath(v);
        break;
      }
      case "select": {
        const cond = this.emitValue(v.cond, "bool");
        const t = this.emitValue(v.whenTrue, v.type);
        const f = this.emitValue(v.whenFalse, v.type);
        result = m.select(cond, t, f);
        break;
      }
      case "convert": {
        result = this.emitConvert(v);
        break;
      }
      case "state-load": {
        const slot = this.layout.stateRegion.slots.find((x) => x.slotId === v.slotId)!;
        result = this.loadStateLayout(slot.offset, slot.type);
        break;
      }
      case "buffer-read": {
        const buf = this.layout.bufferRegion.buffers.find((b) => b.bufferId === v.bufferId)!;
        const idx = this.wrapIndex(this.emitValue(v.idx, "i32"), buf.size);
        const ptr = m.i32.add(
          m.i32.const(buf.offset),
          m.i32.mul(idx, m.i32.const(elemSize(buf.type))),
        );
        if (buf.type === "f32") result = m.f32.load(0, 4, ptr);
        else if (buf.type === "i32") result = m.i32.load(0, 4, ptr);
        else result = m.f64.load(0, 8, ptr);
        break;
      }
      case "buffer-read-interp": {
        const buf = this.layout.bufferRegion.buffers.find((b) => b.bufferId === v.bufferId)!;
        // pos: f32; ip0 = floor(pos); f = pos - ip0; i0 = wrap(ip0); i1 = wrap(i0+1)
        // a = buf[i0]; b = buf[i1]; result = a + (b-a)*f
        const posLocal = this.localTypes.length + 1;
        this.localTypes.push(binaryen.f32);
        this.localTypes.push(binaryen.f32); // f local
        const fLocal = posLocal + 1;
        const i0Local = posLocal + 2;
        this.localTypes.push(binaryen.i32);
        const aLocal = posLocal + 3;
        this.localTypes.push(binaryen.f32);
        const bLocal = posLocal + 4;
        this.localTypes.push(binaryen.f32);
        const pos = this.emitValue(v.pos, "f32");
        result = m.block(null, [
          m.local.set(posLocal, pos),
          m.local.set(fLocal,
            m.f32.sub(
              m.local.get(posLocal, binaryen.f32),
              m.f32.floor(m.local.get(posLocal, binaryen.f32)),
            ),
          ),
          m.local.set(i0Local,
            this.wrapIndex(m.i32.trunc_s.f32(m.f32.floor(m.local.get(posLocal, binaryen.f32))), buf.size),
          ),
          m.local.set(aLocal,
            m.f32.load(0, 4,
              m.i32.add(m.i32.const(buf.offset), m.i32.mul(m.local.get(i0Local, binaryen.i32), m.i32.const(4))),
            ),
          ),
          m.local.set(bLocal,
            m.f32.load(0, 4,
              m.i32.add(m.i32.const(buf.offset),
                m.i32.mul(
                  this.wrapIndex(m.i32.add(m.local.get(i0Local, binaryen.i32), m.i32.const(1)), buf.size),
                  m.i32.const(4)),
              ),
            ),
          ),
          m.f32.add(
            m.local.get(aLocal, binaryen.f32),
            m.f32.mul(
              m.f32.sub(m.local.get(bLocal, binaryen.f32), m.local.get(aLocal, binaryen.f32)),
              m.local.get(fLocal, binaryen.f32),
            ),
          ),
        ]) as any;
        // Set output type via a tee+drop pattern... actually m.block with no
        // tail expression returns void. Need to use the last expression as the
        // return value via type=f32 explicitly.
        result = m.block(
          null,
          [
            m.local.set(posLocal, pos),
            m.local.set(fLocal,
              m.f32.sub(
                m.local.get(posLocal, binaryen.f32),
                m.f32.floor(m.local.get(posLocal, binaryen.f32)),
              ),
            ),
            m.local.set(i0Local,
              this.wrapIndex(m.i32.trunc_s.f32(m.f32.floor(m.local.get(posLocal, binaryen.f32))), buf.size),
            ),
            m.local.set(aLocal,
              m.f32.load(0, 4,
                m.i32.add(m.i32.const(buf.offset), m.i32.mul(m.local.get(i0Local, binaryen.i32), m.i32.const(4))),
              ),
            ),
            m.local.set(bLocal,
              m.f32.load(0, 4,
                m.i32.add(m.i32.const(buf.offset),
                  m.i32.mul(
                    this.wrapIndex(m.i32.add(m.local.get(i0Local, binaryen.i32), m.i32.const(1)), buf.size),
                    m.i32.const(4)),
                ),
              ),
            ),
            m.f32.add(
              m.local.get(aLocal, binaryen.f32),
              m.f32.mul(
                m.f32.sub(m.local.get(bLocal, binaryen.f32), m.local.get(aLocal, binaryen.f32)),
                m.local.get(fLocal, binaryen.f32),
              ),
            ),
          ],
          binaryen.f32,
        );
        break;
      }
      case "buffer-load-vec": {
        const buf = this.layout.bufferRegion.buffers.find((b) => b.bufferId === v.bufferId)!;
        if (buf.type !== "f32") throw new Error("loadVec on non-f32 buffer");
        const off = this.wrapIndex(this.emitValue(v.offset, "i32"), buf.size);
        const ptr = m.i32.add(m.i32.const(buf.offset), m.i32.mul(off, m.i32.const(4)));
        result = m.v128.load(0, 16, ptr);
        actualType = "f32x4";
        break;
      }
      case "audio-in-at": {
        const ai = this.layout.audioInputs.inputs.find((x) => x.inputId === v.inputId)!;
        const i = this.emitValue(v.i, "i32");
        const ptr = m.i32.add(
          m.i32.const(ai.offset + v.channel * ai.channelStride),
          m.i32.mul(i, m.i32.const(4)),
        );
        result = m.f32.load(0, 4, ptr);
        break;
      }
      case "param-at": {
        // Special: messageId/midi may be -1 to indicate payload field — handled
        // separately via message-field nodes. We hit this when graph capture
        // legitimately created a param-at; the messageField nodes are emitted
        // through "message-field" kind below.
        const pl = this.layout.params.layouts.find((x) => x.paramId === v.paramId);
        if (!pl) {
          throw new Error(`param-at: paramId ${v.paramId} not in layout (handler payload?)`);
        }
        if (pl.automationRate === "k-rate") {
          result = m.f32.load(0, 4, m.i32.const(pl.offset));
        } else {
          const i = this.emitValue(v.i, "i32");
          const ptr = m.i32.add(m.i32.const(pl.offset), m.i32.mul(i, m.i32.const(4)));
          result = m.f32.load(0, 4, ptr);
        }
        break;
      }
      case "vec-ctor": {
        // Build via splat + replace_lane
        const lane0 = this.emitValue(v.lanes[0]!, "f32");
        let acc = m.f32x4.splat(lane0);
        for (let i = 1; i < 4; i++) {
          acc = m.f32x4.replace_lane(i, acc, this.emitValue(v.lanes[i]!, "f32"));
        }
        result = acc;
        actualType = "f32x4";
        break;
      }
      case "vec-splat": {
        result = m.f32x4.splat(this.emitValue(v.arg, "f32"));
        actualType = "f32x4";
        break;
      }
      case "vec-lane": {
        result = m.f32x4.extract_lane(v.lane, this.emitValue(v.vec, "f32x4"));
        break;
      }
      case "vec-arith": {
        const a = this.emitValue(v.a, "f32x4");
        const b = this.emitValue(v.b, "f32x4");
        if (v.op === "addVec") result = m.f32x4.add(a, b);
        else if (v.op === "subVec") result = m.f32x4.sub(a, b);
        else if (v.op === "mulVec") result = m.f32x4.mul(a, b);
        else result = m.f32x4.div(a, b);
        actualType = "f32x4";
        break;
      }
      case "message-field":
      case "message-var-len":
      case "message-var-read":
      case "midi-field":
        // These nodes only appear inside message/MIDI handler bodies; their
        // emission requires the slotPtr local for the current handler. They
        // are handled inside emitHandler.
        throw new Error(`${v.kind} encountered in process body — should only appear in handler`);
    }

    // Type coercion if expectedType differs from actualType (for bool/i32 mixups)
    if (expectedType && actualType !== expectedType) {
      result = this.coerce(result, actualType, expectedType);
    }
    return result;
  }

  coerce(expr: ExprRef, from: AnyType, to: AnyType): ExprRef {
    if (from === to) return expr;
    const m = this.m;
    if (from === "bool" && to === "i32") return expr; // bool already i32
    if (from === "i32" && to === "bool") return m.i32.ne(expr, m.i32.const(0));
    if (from === "i32" && to === "f32") return m.f32.convert_s.i32(expr);
    if (from === "f32" && to === "i32") return m.i32.trunc_s.f32(expr);
    if (from === "i32" && to === "f64") return m.f64.convert_s.i32(expr);
    if (from === "f64" && to === "i32") return m.i32.trunc_s.f64(expr);
    if (from === "f32" && to === "f64") return m.f64.promote(expr);
    if (from === "f64" && to === "f32") return m.f32.demote(expr);
    return expr;
  }

  emitArith(v: any): ExprRef {
    const m = this.m;
    const t = v.type as ScalarType;
    const args = v.args.map((a: any) => this.emitValue(a, t));
    const op = v.op;
    const isF32 = t === "f32";
    const isF64 = t === "f64";
    const isI32 = t === "i32" || t === "bool";
    if (op === "add") {
      if (isF32) return m.f32.add(args[0], args[1]);
      if (isF64) return m.f64.add(args[0], args[1]);
      return m.i32.add(args[0], args[1]);
    }
    if (op === "sub") {
      if (isF32) return m.f32.sub(args[0], args[1]);
      if (isF64) return m.f64.sub(args[0], args[1]);
      return m.i32.sub(args[0], args[1]);
    }
    if (op === "mul") {
      if (isF32) return m.f32.mul(args[0], args[1]);
      if (isF64) return m.f64.mul(args[0], args[1]);
      return m.i32.mul(args[0], args[1]);
    }
    if (op === "div") {
      if (isF32) return m.f32.div(args[0], args[1]);
      if (isF64) return m.f64.div(args[0], args[1]);
      return m.i32.div_s(args[0], args[1]);
    }
    if (op === "mod") {
      if (isF32 || isF64) {
        // x - floor(x/y)*y for proper modulo
        const div = isF32 ? m.f32.div(args[0], args[1]) : m.f64.div(args[0], args[1]);
        const fl = isF32 ? m.f32.floor(div) : m.f64.floor(div);
        const flMul = isF32 ? m.f32.mul(fl, args[1]) : m.f64.mul(fl, args[1]);
        return isF32 ? m.f32.sub(args[0], flMul) : m.f64.sub(args[0], flMul);
      }
      return m.i32.rem_s(args[0], args[1]);
    }
    if (op === "neg") {
      if (isF32) return m.f32.neg(args[0]);
      if (isF64) return m.f64.neg(args[0]);
      return m.i32.sub(m.i32.const(0), args[0]);
    }
    if (op === "min") {
      if (isF32) return m.f32.min(args[0], args[1]);
      if (isF64) return m.f64.min(args[0], args[1]);
      return m.select(m.i32.lt_s(args[0], args[1]), args[0], args[1]);
    }
    if (op === "max") {
      if (isF32) return m.f32.max(args[0], args[1]);
      if (isF64) return m.f64.max(args[0], args[1]);
      return m.select(m.i32.gt_s(args[0], args[1]), args[0], args[1]);
    }
    if (op === "abs") {
      if (isF32) return m.f32.abs(args[0]);
      if (isF64) return m.f64.abs(args[0]);
      return m.select(m.i32.lt_s(args[0], m.i32.const(0)), m.i32.sub(m.i32.const(0), args[0]), args[0]);
    }
    if (op === "clamp") {
      // max(min(v, hi), lo)
      const minHi = isF32 ? m.f32.min(args[0], args[2]) : isF64 ? m.f64.min(args[0], args[2]) : m.select(m.i32.lt_s(args[0], args[2]), args[0], args[2]);
      const maxLo = isF32 ? m.f32.max(minHi, args[1]) : isF64 ? m.f64.max(minHi, args[1]) : m.select(m.i32.gt_s(minHi, args[1]), minHi, args[1]);
      return maxLo;
    }
    throw new Error(`unhandled arith op ${op}`);
  }

  emitCompare(v: any): ExprRef {
    const m = this.m;
    const t = v.a.type as ScalarType;
    const a = this.emitValue(v.a, t);
    const b = this.emitValue(v.b, t);
    const op = v.op;
    if (t === "f32") {
      return op === "eq" ? m.f32.eq(a, b)
           : op === "ne" ? m.f32.ne(a, b)
           : op === "lt" ? m.f32.lt(a, b)
           : op === "gt" ? m.f32.gt(a, b)
           : op === "lte" ? m.f32.le(a, b)
           : m.f32.ge(a, b);
    }
    if (t === "f64") {
      return op === "eq" ? m.f64.eq(a, b)
           : op === "ne" ? m.f64.ne(a, b)
           : op === "lt" ? m.f64.lt(a, b)
           : op === "gt" ? m.f64.gt(a, b)
           : op === "lte" ? m.f64.le(a, b)
           : m.f64.ge(a, b);
    }
    return op === "eq" ? m.i32.eq(a, b)
         : op === "ne" ? m.i32.ne(a, b)
         : op === "lt" ? m.i32.lt_s(a, b)
         : op === "gt" ? m.i32.gt_s(a, b)
         : op === "lte" ? m.i32.le_s(a, b)
         : m.i32.ge_s(a, b);
  }

  emitMath(v: any): ExprRef {
    const m = this.m;
    const t = v.type as ScalarType;
    const arg = this.emitValue(v.arg, t);
    const op = v.op;
    if (op === "sqrt") {
      if (t === "f32") return m.f32.sqrt(arg);
      if (t === "f64") return m.f64.sqrt(arg);
    }
    if (op === "floor") {
      if (t === "f32") return m.f32.floor(arg);
      if (t === "f64") return m.f64.floor(arg);
    }
    if (op === "ceil") {
      if (t === "f32") return m.f32.ceil(arg);
      if (t === "f64") return m.f64.ceil(arg);
    }
    if (op === "frac") {
      // x - floor(x)
      if (t === "f32") return m.f32.sub(arg, m.f32.floor(arg));
      if (t === "f64") return m.f64.sub(arg, m.f64.floor(arg));
    }
    // For sin/cos/tan/tanh/exp/log: import from JS Math.
    let importName: string;
    if (op === "tanh") {
      // tanh(x) = (exp(2x) - 1) / (exp(2x) + 1) — use math import
      // We don't have a math_tanh import; add it on demand by using a helper.
      // Simpler: import tanh directly. Add on first use.
      importName = "math_tanh";
      if (!this.mathImports.has("tanh")) {
        // already declared in declareMathImports
        this.mathImports.set("tanh", 1);
      }
    } else {
      importName = `math_${op}`;
    }
    // Convert arg to f64, call import, convert back to original type.
    const argF64 = t === "f64" ? arg : m.f64.promote(arg);
    const callRes = m.call(importName, [argF64], binaryen.f64);
    if (t === "f32") return m.f32.demote(callRes);
    return callRes;
  }

  emitConvert(v: any): ExprRef {
    const m = this.m;
    const arg = this.emitValue(v.arg, v.from);
    return this.coerce(arg, v.from, v.type);
  }

  // Compute a non-negative wrapped index: ((idx % size) + size) % size
  // Implemented as: tmp = idx % size; if (tmp < 0) tmp + size; else tmp
  wrapIndex(idx: ExprRef, size: number): ExprRef {
    const m = this.m;
    const sizeC = m.i32.const(size);
    const r = m.i32.rem_s(idx, sizeC);
    return m.select(m.i32.lt_s(r, m.i32.const(0)), m.i32.add(r, sizeC), r);
  }

  // ─── Message handlers ───────────────────────────────────────────────────

  buildMessageHandlers() {
    for (const handler of this.graph.messageHandlers) {
      const ml = this.layout.messages.layouts.find((x) => x.messageId === handler.messageId);
      if (!ml) continue;
      this.localTypes = [];
      // local 0: slotPtr (i32 param)
      // We expose payload field reads via custom local helpers.
      // Walk the handler body, replacing message-field nodes with loads.
      const stmts = handler.body.map((s) => this.emitStmtInHandler(s, ml.fieldOffsets, "messages"));
      this.m.addFunction(
        `msgHandler_${handler.messageId}`,
        binaryen.createType([binaryen.i32]),
        binaryen.none,
        this.localTypes,
        this.m.block(null, stmts),
      );
    }
  }

  buildMidiHandlers() {
    for (const handler of this.graph.midiHandlers) {
      this.localTypes = [];
      // Build payload field access for MIDI events: status/data1/data2 are bytes 0-2;
      // atSample is u32 at offset 4.
      // Channel = status & 0x0f. Other fields per event type.
      const stmts = handler.body.map((s) => this.emitStmtInMidiHandler(s, handler.eventType));
      this.m.addFunction(
        `midiHandler_${handler.midiInputId}_${handler.eventType}`,
        binaryen.createType([binaryen.i32]),
        binaryen.none,
        this.localTypes,
        this.m.block(null, stmts),
      );
    }
  }

  // Emit a statement inside a message handler. The slot pointer is in local 0.
  // payload-field nodes resolve to loads from slotPtr + fieldOffset.
  emitStmtInHandler(
    s: Statement,
    fieldOffsets: Record<string, { offset: number; type: ScalarType }>,
    _kind: "messages",
  ): ExprRef {
    // Use a custom emitValue that routes message-field through field offsets.
    const origLoopVarLocals = this.loopVarLocals;
    this.loopVarLocals = [];
    const origEmitValue = this.emitValue.bind(this);
    const replaced = (v: ASTValue, expected?: AnyType): ExprRef => {
      if (v.kind === "message-field") {
        const fl = fieldOffsets[v.fieldName];
        if (!fl) return this.m.i32.const(0);
        const ptr = this.m.i32.add(this.m.local.get(0, binaryen.i32), this.m.i32.const(fl.offset));
        let r: ExprRef;
        if (fl.type === "f32") r = this.m.f32.load(0, 4, ptr);
        else if (fl.type === "i32" || fl.type === "bool") r = this.m.i32.load(0, 4, ptr);
        else r = this.m.f64.load(0, 8, ptr);
        return expected ? this.coerce(r, fl.type, expected) : r;
      }
      // The legacy "param-at" sentinel from the old capture-decls.ts was used
      // for message fields when paramId === -1; treat them as message-field too.
      if (v.kind === "param-at" && (v as any).__messagePayloadField) {
        const sentinel = (v as any).__messagePayloadField;
        const fl = fieldOffsets[sentinel.name];
        if (fl) {
          const ptr = this.m.i32.add(this.m.local.get(0, binaryen.i32), this.m.i32.const(fl.offset));
          let r: ExprRef;
          if (fl.type === "f32") r = this.m.f32.load(0, 4, ptr);
          else if (fl.type === "i32" || fl.type === "bool") r = this.m.i32.load(0, 4, ptr);
          else r = this.m.f64.load(0, 8, ptr);
          return expected ? this.coerce(r, fl.type, expected) : r;
        }
      }
      return origEmitValue(v, expected);
    };
    this.emitValue = replaced as any;
    try {
      return this.emitStmt(s);
    } finally {
      this.emitValue = origEmitValue;
      this.loopVarLocals = origLoopVarLocals;
    }
  }

  emitStmtInMidiHandler(s: Statement, eventType: string): ExprRef {
    // Field readers per event type. slotPtr is local 0.
    const m = this.m;
    const slotPtr = () => m.local.get(0, binaryen.i32);
    const status = () => m.i32.load8_u(0, 1, slotPtr());
    const data1 = () => m.i32.load8_u(0, 1, m.i32.add(slotPtr(), m.i32.const(1)));
    const data2 = () => m.i32.load8_u(0, 1, m.i32.add(slotPtr(), m.i32.const(2)));
    const atSample = () => m.i32.load(0, 4, m.i32.add(slotPtr(), m.i32.const(4)));
    const channel = () => m.i32.and(status(), m.i32.const(0x0f));
    const fields: Record<string, () => ExprRef> = {};
    fields["channel"] = channel;
    fields["atSample"] = atSample;
    if (eventType === "noteOn" || eventType === "noteOff") {
      fields["note"] = data1;
      fields["velocity"] = data2;
    } else if (eventType === "cc") {
      fields["controller"] = data1;
      fields["value"] = data2;
    } else if (eventType === "pitchBend") {
      // (data2 << 7) | data1
      fields["value"] = () => m.i32.or(m.i32.shl(data2(), m.i32.const(7)), data1());
    } else if (eventType === "programChange") {
      fields["program"] = data1;
    } else if (eventType === "channelPressure") {
      fields["pressure"] = data1;
    } else if (eventType === "aftertouch") {
      fields["note"] = data1;
      fields["pressure"] = data2;
    } else if (eventType === "systemRealtime") {
      fields["status"] = status;
    }
    const origLoopVarLocals = this.loopVarLocals;
    this.loopVarLocals = [];
    const origEmitValue = this.emitValue.bind(this);
    const replaced = (v: ASTValue, expected?: AnyType): ExprRef => {
      if (v.kind === "midi-field") {
        const f = fields[v.fieldName];
        if (!f) return m.i32.const(0);
        const r = f();
        return expected && expected !== "i32" ? this.coerce(r, "i32", expected) : r;
      }
      // Legacy sentinel
      if (v.kind === "param-at" && (v as any).__midiPayloadField) {
        const fname = (v as any).__midiPayloadField.name;
        const f = fields[fname];
        if (f) {
          const r = f();
          return expected && expected !== "i32" ? this.coerce(r, "i32", expected) : r;
        }
      }
      return origEmitValue(v, expected);
    };
    this.emitValue = replaced as any;
    try {
      return this.emitStmt(s);
    } finally {
      this.emitValue = origEmitValue;
      this.loopVarLocals = origLoopVarLocals;
    }
  }
}

// Public API
export function emitWasm(
  graph: CapturedGraph,
  layout: MemoryLayout,
): { binary: Uint8Array; text: string; layout: MemoryLayout } {
  const e = new Emit(graph, layout);
  return e.build();
}
