// Declarations + control flow primitives for capture mode.

import { getCtx, lift } from "./capture.js";
import { makeVecValue } from "./capture-simd.js";
import type {
  ASTValue,
  ScalarType,
  Statement,
  StateDecl,
  BufferDecl,
  ParamDecl,
  AudioInputDecl,
  AudioOutputDecl,
  EventDecl,
  MessageDecl,
  MidiInputDecl,
  MidiOutputDecl,
  SnapshotPolicy,
} from "./ast.js";

// ─── State ──────────────────────────────────────────────────────────────────

function declareState<T extends ScalarType>(
  type: T,
  initial: number | boolean,
  options?: { name?: string; snapshot?: SnapshotPolicy; publish?: { rateFps: number } },
) {
  const c = getCtx();
  const scope = c.currentScope();
  const path = scope.pathPrefix + (options?.name ?? `__anon_state_${scope.states.length}`);
  const decl: StateDecl = {
    id: c.stateIdCounter++,
    kind: "state",
    type,
    initial,
    name: options?.name,
    path,
    snapshot: options?.snapshot ?? "persistent",
    publish: options?.publish,
  };
  scope.states.push(decl);
  c.graph.declarations.states.push(decl);
  const slotId = decl.id;
  return {
    load: () => {
      return c.fresh({
        kind: "state-load",
        type,
        slotId,
      } as any);
    },
    store: (v: any) => {
      const stmt: Statement = {
        kind: "state-store",
        slotId,
        value: lift(v, type),
      };
      c.emit(stmt);
    },
    __isState: true,
    __type: type,
    __name: options?.name,
    __slotId: slotId,
  };
}

export const state = {
  f32: (initial: number, options?: any) => declareState("f32", initial, options),
  f64: (initial: number, options?: any) => declareState("f64", initial, options),
  i32: (initial: number, options?: any) => declareState("i32", initial, options),
  i64: (initial: number, options?: any) => declareState("i64", initial, options),
  bool: (initial: boolean, options?: any) => declareState("bool", initial, options),
};

// ─── Buffer ────────────────────────────────────────────────────────────────

function declareBuffer<T extends ScalarType>(type: T, options: any) {
  const c = getCtx();
  const scope = c.currentScope();
  const decl: BufferDecl = {
    id: c.bufferIdCounter++,
    kind: "buffer",
    type,
    size: options.size,
    name: options.name,
    path: scope.pathPrefix + options.name,
    snapshot: options.snapshot ?? "transient",
    publish: options.publish,
  };
  scope.buffers.push(decl);
  c.graph.declarations.buffers.push(decl);
  const bufferId = decl.id;

  return {
    read: (idx: any) => {
      return c.fresh({
        kind: "buffer-read",
        type,
        bufferId,
        idx: lift(idx, "i32"),
      } as any);
    },
    write: (idx: any, v: any) => {
      c.emit({
        kind: "buffer-write",
        bufferId,
        idx: lift(idx, "i32"),
        value: lift(v, type),
      });
    },
    readInterpolated: (pos: any) => {
      if (type !== "f32") throw new Error("readInterpolated requires buffer.f32");
      return c.fresh({
        kind: "buffer-read-interp",
        type,
        bufferId,
        pos: lift(pos, "f32"),
      } as any);
    },
    loadVec: (offset: any) => {
      if (type !== "f32") throw new Error("loadVec requires buffer.f32");
      const v = c.fresh({
        kind: "buffer-load-vec",
        type: "f32x4" as any,
        bufferId,
        offset: lift(offset, "i32"),
      } as any);
      return makeVecValue(v);
    },
    storeVec: (offset: any, value: any) => {
      if (type !== "f32") throw new Error("storeVec requires buffer.f32");
      c.emit({
        kind: "buffer-store-vec",
        bufferId,
        offset: lift(offset, "i32"),
        value,
      });
    },
    size: options.size,
    name: options.name,
    __isBuffer: true,
    __type: type,
  };
}

export const buffer = {
  f32: (options: any) => declareBuffer("f32", options),
  f64: (options: any) => declareBuffer("f64", options),
  i32: (options: any) => declareBuffer("i32", options),
};

// ─── Param ─────────────────────────────────────────────────────────────────

export function param(options: {
  default: number;
  min: number;
  max: number;
  automationRate: "a-rate" | "k-rate";
  unit?: string;
  name: string;
  snapshot?: SnapshotPolicy;
}) {
  const c = getCtx();
  const decl: ParamDecl = {
    id: c.paramIdCounter++,
    kind: "param",
    name: options.name,
    default: options.default,
    min: options.min,
    max: options.max,
    automationRate: options.automationRate,
    unit: options.unit,
    snapshot: options.snapshot ?? "persistent",
  };
  c.graph.declarations.params.push(decl);
  const paramId = decl.id;
  return {
    at: (i: any) => {
      return c.fresh({
        kind: "param-at",
        type: "f32",
        paramId,
        i: lift(i, "i32"),
      } as any);
    },
    __isParam: true,
    __name: options.name,
    __paramId: paramId,
  };
}

// ─── Audio I/O ──────────────────────────────────────────────────────────────

export function audioInput(options: { channels: number; name: string }) {
  const c = getCtx();
  const decl: AudioInputDecl = {
    id: c.audioInputIdCounter++,
    kind: "audioInput",
    name: options.name,
    channels: options.channels,
  };
  c.graph.declarations.audioInputs.push(decl);
  const inputId = decl.id;
  return {
    at: (channel: any, i: any) => {
      return c.fresh({
        kind: "audio-in-at",
        type: "f32",
        inputId,
        channel: channel as number,
        i: lift(i, "i32"),
      } as any);
    },
    channels: options.channels,
    name: options.name,
    __isAudioInput: true,
  };
}

export function audioOutput(options: { channels: number; name: string }) {
  const c = getCtx();
  const decl: AudioOutputDecl = {
    id: c.audioOutputIdCounter++,
    kind: "audioOutput",
    name: options.name,
    channels: options.channels,
  };
  c.graph.declarations.audioOutputs.push(decl);
  const outputId = decl.id;
  return {
    set: (channel: any, i: any, v: any) => {
      c.emit({
        kind: "audio-out-set",
        outputId,
        channel: channel as number,
        i: lift(i, "i32"),
        value: lift(v, "f32"),
      });
    },
    channels: options.channels,
    name: options.name,
    __isAudioOutput: true,
  };
}

// ─── Events / Messages ──────────────────────────────────────────────────────

export function event<T = any>(options: { name: string; capacity?: number }) {
  const c = getCtx();
  // Defer the field schema until the first emit — we observe field names + types
  // from the payload literal. Default: empty fields, will be filled dynamically.
  const decl: EventDecl = {
    id: c.eventIdCounter++,
    kind: "event",
    name: options.name,
    capacity: options.capacity ?? 256,
    fields: [],
  };
  c.graph.declarations.events.push(decl);
  const eventId = decl.id;
  return {
    emitIf: (cond: any, payload: any) => {
      const condV = lift(cond, "bool");
      const atSample = lift(payload.atSample ?? 0, "i32");
      const fields: Array<{ name: string; value: ASTValue; type: ScalarType }> = [];
      let varField: { name: string; value: ASTValue; elemType: ScalarType } | undefined;
      for (const [k, v] of Object.entries(payload)) {
        if (k === "atSample") continue;
        // Variable-length field detection: Float32Array etc.
        if (
          v instanceof Float32Array ||
          v instanceof Int32Array ||
          v instanceof Uint8Array
        ) {
          // Emitting a typed-array as part of an event payload from inside the
          // graph is not supported in this initial pass — those values are
          // computed on the JS side, not in the WASM body. We accept a "ref"
          // pattern: payload contains a value that is treated as a pointer into
          // a pre-allocated content buffer, but for the initial implementation
          // we only handle the fixed-field case from inside WASM.
          throw new Error(
            "Variable-length event payload from inside WASM body is not yet supported. Use a state.publish slot for typed-array data, or send fixed-size fields and look up the array on main side.",
          );
        }
        const lifted = lift(v, "f32");
        const type: ScalarType = lifted.type as ScalarType;
        fields.push({ name: k, value: lifted, type });
      }
      // First emit defines the schema; subsequent emits must match.
      if (decl.fields.length === 0) {
        decl.fields = fields.map((f) => ({ name: f.name, type: f.type }));
      } else {
        if (fields.length !== decl.fields.length) {
          throw new Error(
            `event<T> '${options.name}': inconsistent payload shape across emit sites`,
          );
        }
      }
      c.emit({
        kind: "emit-if",
        eventId,
        cond: condV,
        atSample,
        fields,
        varField,
      });
    },
    __isEvent: true,
    __name: options.name,
    __eventId: eventId,
  };
}

export function message<T = any>(options: { name: string; capacity?: number }) {
  const c = getCtx();
  const decl: MessageDecl = {
    id: c.messageIdCounter++,
    kind: "message",
    name: options.name,
    capacity: options.capacity ?? 256,
    fields: [],
  };
  c.graph.declarations.messages.push(decl);
  const messageId = decl.id;
  return {
    onReceive: (handler: (payload: any) => void) => {
      // Run handler in capture mode with a payload proxy. We need to know the
      // payload schema — we ask the user to declare via a special "schema"
      // call, OR we observe via property access on a Proxy.
      const schema: Array<{ name: string; type: ScalarType }> = [];
      let varField: { name: string; elemType: ScalarType } | undefined;
      const observed = new Set<string>();

      // For variable-length fields (typed arrays), we need a different
      // approach. Since we can't statically know whether a field is a
      // typed-array, we accept a runtime convention: the user can declare
      // `samples: Float32Array` in TS and we'll detect it via a name-based
      // heuristic at codegen time. For now we capture all field accesses
      // as scalar f32 reads and rely on call-site annotations.

      // We create a payload proxy whose property accesses produce ParamConst-like
      // AST values.
      const payloadProxy = new Proxy(
        {},
        {
          get(_t, prop) {
            if (typeof prop !== "string") return undefined;
            if (!observed.has(prop)) {
              observed.add(prop);
              schema.push({ name: prop, type: "f32" });
            }
            // Return an AST value reading from the message-payload slot
            return c.fresh({
              kind: "param-at",
              // Re-use param-at semantics for now: payload field reads are
              // generated specially at WASM emission time. We'll mark the
              // ASTValue with a special tag.
              // TODO: introduce a dedicated MessageFieldRead node.
              type: "f32",
              paramId: -1, // sentinel
              i: { id: -1, kind: "const", type: "i32", value: 0 } as any,
              // @ts-expect-error custom field
              __messagePayloadField: { messageId, name: prop, type: "f32" },
            } as any);
          },
        },
      );

      // Handler bodies emit into a fresh body list.
      const body: Statement[] = [];
      c.bodyStack.push(body);
      try {
        handler(payloadProxy);
      } finally {
        c.bodyStack.pop();
      }
      // Update schema; merge with any prior calls.
      if (decl.fields.length === 0) {
        decl.fields = schema;
      }
      const list = c.messageHandlerBodies.get(messageId) ?? [];
      list.push({ body, payloadFields: decl.fields, varField });
      c.messageHandlerBodies.set(messageId, list);
    },
    __isMessage: true,
    __name: options.name,
    __messageId: messageId,
  };
}

// ─── MIDI ──────────────────────────────────────────────────────────────────

export function midiInput(options: { name?: string; capacity?: number } = {}) {
  const c = getCtx();
  const decl: MidiInputDecl = {
    id: c.midiInputIdCounter++,
    kind: "midiInput",
    name: options.name ?? "midi",
    capacity: options.capacity ?? 256,
  };
  c.graph.declarations.midiInputs.push(decl);
  const midiInputId = decl.id;
  return {
    onEvent: (eventType: string, handler: (e: any) => void) => {
      // Build a payload proxy — fields depend on event type.
      const fieldsByType: Record<string, string[]> = {
        noteOn: ["channel", "note", "velocity", "atSample"],
        noteOff: ["channel", "note", "velocity", "atSample"],
        cc: ["channel", "controller", "value", "atSample"],
        pitchBend: ["channel", "value", "atSample"],
        programChange: ["channel", "program", "atSample"],
        channelPressure: ["channel", "pressure", "atSample"],
        aftertouch: ["channel", "note", "pressure", "atSample"],
        systemRealtime: ["status", "atSample"],
        sysex: ["data", "atSample"],
      };
      const fields = fieldsByType[eventType] ?? [];
      const payload: any = {};
      for (const f of fields) {
        payload[f] = c.fresh({
          kind: "param-at",
          type: "i32",
          paramId: -1,
          i: { id: -1, kind: "const", type: "i32", value: 0 } as any,
          // @ts-expect-error custom
          __midiPayloadField: { midiInputId, eventType, name: f },
        } as any);
      }
      const body: Statement[] = [];
      c.bodyStack.push(body);
      try {
        handler(payload);
      } finally {
        c.bodyStack.pop();
      }
      const map = c.midiHandlerBodies.get(midiInputId) ?? new Map();
      map.set(eventType, body);
      c.midiHandlerBodies.set(midiInputId, map);
    },
    __isMidiInput: true,
    __name: decl.name,
  };
}

export function midiOutput(options: { name?: string; capacity?: number } = {}) {
  const c = getCtx();
  const decl: MidiOutputDecl = {
    id: c.midiOutputIdCounter++,
    kind: "midiOutput",
    name: options.name ?? "midiOut",
    capacity: options.capacity ?? 256,
  };
  c.graph.declarations.midiOutputs.push(decl);
  const midiOutputId = decl.id;
  return {
    emitIf: (cond: any, ev: any) => {
      // Encode MIDI event to status/data1/data2 by type.
      const condV = lift(cond, "bool");
      const atSample = lift(ev.atSample ?? 0, "i32");
      let status: ASTValue, data1: ASTValue, data2: ASTValue;
      const ch = lift(ev.channel ?? 0, "i32");
      switch (ev.type) {
        case "noteOn":
          status = arithFor("add", lift(0x90, "i32"), ch);
          data1 = lift(ev.note, "i32");
          data2 = lift(ev.velocity, "i32");
          break;
        case "noteOff":
          status = arithFor("add", lift(0x80, "i32"), ch);
          data1 = lift(ev.note, "i32");
          data2 = lift(ev.velocity, "i32");
          break;
        case "cc":
          status = arithFor("add", lift(0xb0, "i32"), ch);
          data1 = lift(ev.controller, "i32");
          data2 = lift(ev.value, "i32");
          break;
        case "pitchBend": {
          status = arithFor("add", lift(0xe0, "i32"), ch);
          // 14-bit value -> lsb / msb
          const v = lift(ev.value, "i32");
          data1 = arithFor("mod", v, lift(128, "i32"));
          data2 = arithFor("div", v, lift(128, "i32"));
          break;
        }
        case "programChange":
          status = arithFor("add", lift(0xc0, "i32"), ch);
          data1 = lift(ev.program, "i32");
          data2 = lift(0, "i32");
          break;
        case "channelPressure":
          status = arithFor("add", lift(0xd0, "i32"), ch);
          data1 = lift(ev.pressure, "i32");
          data2 = lift(0, "i32");
          break;
        case "aftertouch":
          status = arithFor("add", lift(0xa0, "i32"), ch);
          data1 = lift(ev.note, "i32");
          data2 = lift(ev.pressure, "i32");
          break;
        case "systemRealtime":
          status = lift(ev.status, "i32");
          data1 = lift(0, "i32");
          data2 = lift(0, "i32");
          break;
        default:
          throw new Error(`MIDI emit type '${ev.type}' not yet supported in WASM emit`);
      }
      c.emit({
        kind: "midi-emit-if",
        midiOutputId,
        cond: condV,
        status,
        data1,
        data2,
        atSample,
      });
    },
    __isMidiOutput: true,
    __name: decl.name,
  };
}

// Helper: build an arithmetic AST node for use inside other primitives (not
// directly exposed to user code).
function arithFor(op: any, a: ASTValue, b: ASTValue): ASTValue {
  const c = getCtx();
  return c.fresh({
    kind: "arith",
    type: a.type,
    op,
    args: [a, b],
  });
}

// ─── forSample / forSample.byN / everyNSamples ─────────────────────────────

function forSampleImpl(stride: number, callback: (i: any) => void) {
  const c = getCtx();
  const i = c.pushLoopVar();
  const body: Statement[] = [];
  c.bodyStack.push(body);
  try {
    callback(i);
  } finally {
    c.bodyStack.pop();
    c.popLoopVar();
  }
  c.emit({ kind: "for-sample", stride, body });
}

export const forSample = Object.assign(
  (callback: any) => forSampleImpl(1, callback),
  {
    byN: (stride: number, callback: any) => {
      if (!Number.isInteger(stride) || stride <= 0) {
        throw new Error(`forSample.byN stride must be a positive integer; got ${stride}`);
      }
      forSampleImpl(stride, callback);
    },
  },
);

export function everyNSamples(N: number, callback: () => void) {
  const c = getCtx();
  if (!Number.isInteger(N) || N <= 0) {
    throw new Error(`everyNSamples N must be a positive integer; got ${N}`);
  }
  const body: Statement[] = [];
  c.bodyStack.push(body);
  try {
    callback();
  } finally {
    c.bodyStack.pop();
  }
  c.emit({ kind: "every-n-samples", N, body });
}

// ─── defineSubgraph (inlined in capture) ───────────────────────────────────
//
// The returned function MUST be stable across multiple invocations from the
// SAME body — so we key wrappers by `body` reference. Callers (incl. the
// dispatch in @unworklet/core) call `defineSubgraph(body)` per invocation,
// but the same body should always yield the same wrapper / subgraph id.

export function defineSubgraph<A extends any[], R>(body: (...args: A) => R) {
  const c = getCtx();
  let sgId = c.subgraphIdsByBody.get(body);
  let wrapper = c.subgraphWrappersByBody.get(body) as ((...a: A) => R) | undefined;
  if (sgId === undefined) {
    sgId = c.subgraphIdCounter++;
    c.subgraphIdsByBody.set(body, sgId);
  }
  if (wrapper) return wrapper;
  const sId = sgId;
  wrapper = function (...args: A): R {
    const cc = getCtx();
    const parentScope = cc.currentScope();
    let pool = parentScope.subgraphInstances.get(sId);
    if (!pool) {
      pool = [];
      parentScope.subgraphInstances.set(sId, pool);
      parentScope.subgraphCursors.set(sId, 0);
    }
    const cursor = parentScope.subgraphCursors.get(sId) ?? 0;
    let inst = pool[cursor];
    if (!inst) {
      const childScope: any = {
        states: [],
        buffers: [],
        subgraphInstances: new Map(),
        subgraphCursors: new Map(),
        pathPrefix: parentScope.pathPrefix + `__sg${sId}_${cursor}/`,
        declared: false,
        resetSubgraphCursors() {
          for (const [k] of this.subgraphCursors) this.subgraphCursors.set(k, 0);
        },
      };
      inst = { scope: childScope, cursor };
      pool.push(inst);
    }
    parentScope.subgraphCursors.set(sId, cursor + 1);
    cc.pushScope(inst.scope as any);
    let result: any;
    try {
      result = body(...args);
      if (result && typeof result === "object" && typeof result.process === "function") {
        result = result.process();
      }
    } finally {
      cc.popScope();
    }
    return result as R;
  };
  c.subgraphWrappersByBody.set(body, wrapper);
  return wrapper;
}
