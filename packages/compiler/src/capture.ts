// Graph capture: runs the user's defineProcessor body once at build time with
// proxy primitives that build an AST instead of computing values. Output is
// a CapturedGraph (see ast.ts).
//
// This module is the *only* place where AST nodes are constructed. Both the
// WASM emitter and the pure-JS interpreter (used for testing) operate over
// the captured graph.

import type {
  ASTValue,
  AnyType,
  ScalarType,
  Statement,
  CapturedGraph,
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

// ─── Capture context (module-private, set by `capture()`) ────────────────────

class Scope {
  states: StateDecl[] = [];
  buffers: BufferDecl[] = [];
  // For each subgraph definition (by id), instance pool by call-site cursor.
  subgraphInstances: Map<number, { scope: Scope; cursor: number }[]> = new Map();
  subgraphCursors: Map<number, number> = new Map();
  pathPrefix: string;
  declared = false;

  constructor(pathPrefix: string) {
    this.pathPrefix = pathPrefix;
  }

  resetSubgraphCursors() {
    for (const [k] of this.subgraphCursors) this.subgraphCursors.set(k, 0);
  }
}

class CaptureCtx {
  graph: CapturedGraph;
  scopeStack: Scope[];

  // Statement collection: a stack of body lists. Statements emitted go onto
  // the top-most list. forSample / everyNSamples push new lists.
  bodyStack: Statement[][];

  // Loop variable stack: when inside forSample, the `i` proxy resolves to a
  // LoopVar node with depth = loopVarStack.length-1.
  loopVarStack: ASTValue[];

  nodeIdCounter = 0;
  stateIdCounter = 0;
  bufferIdCounter = 0;
  paramIdCounter = 0;
  audioInputIdCounter = 0;
  audioOutputIdCounter = 0;
  eventIdCounter = 0;
  messageIdCounter = 0;
  midiInputIdCounter = 0;
  midiOutputIdCounter = 0;

  // Subgraph definition counter (each defineSubgraph body gets a unique id).
  subgraphIdCounter = 0;
  subgraphIdsByBody: Map<Function, number> = new Map();
  subgraphWrappersByBody: Map<Function, Function> = new Map();

  // While processing the user's process body, we register message/midi
  // handlers. We collect them here keyed by message/midi-input id and
  // event type.
  messageHandlerBodies: Map<
    number,
    {
      body: Statement[];
      payloadFields: Array<{ name: string; type: ScalarType }>;
      varField?: { name: string; elemType: ScalarType };
    }[]
  > = new Map();
  midiHandlerBodies: Map<
    number,
    Map<string, Statement[]>
  > = new Map();

  // Sample rate / render quantum used for ctx.* constant resolution.
  sampleRate: number;
  renderQuantum: number;

  // Are we currently inside the user's process body? (Determines what
  // primitives are legal.)
  inProcessBody = false;

  constructor(opts: { sampleRate: number; renderQuantum: number }) {
    this.sampleRate = opts.sampleRate;
    this.renderQuantum = opts.renderQuantum;
    const root = new Scope("");
    this.scopeStack = [root];
    this.bodyStack = [[]];
    this.loopVarStack = [];
    this.graph = {
      declarations: {
        states: [],
        buffers: [],
        params: [],
        audioInputs: [],
        audioOutputs: [],
        events: [],
        messages: [],
        midiInputs: [],
        midiOutputs: [],
      },
      processBody: [],
      messageHandlers: [],
      midiHandlers: [],
      schemaHash: "",
    };
  }

  rootScope(): Scope {
    return this.scopeStack[0]!;
  }

  currentScope(): Scope {
    return this.scopeStack[this.scopeStack.length - 1]!;
  }

  pushScope(s: Scope) {
    this.scopeStack.push(s);
  }

  popScope() {
    this.scopeStack.pop();
  }

  pushBody(): Statement[] {
    const list: Statement[] = [];
    this.bodyStack.push(list);
    return list;
  }

  popBody() {
    return this.bodyStack.pop()!;
  }

  emit(stmt: Statement) {
    this.bodyStack[this.bodyStack.length - 1]!.push(stmt);
  }

  pushLoopVar(): ASTValue {
    const depth = this.loopVarStack.length;
    const v: ASTValue = {
      id: this.nodeIdCounter++,
      kind: "loop-var",
      type: "i32",
      depth,
    } as ASTValue;
    this.loopVarStack.push(v);
    return v;
  }

  popLoopVar() {
    return this.loopVarStack.pop()!;
  }

  fresh<N extends ASTValue>(node: Omit<N, "id">): N {
    return { ...node, id: this.nodeIdCounter++ } as N;
  }
}

let ctx: CaptureCtx | null = null;

export function getCtx(): CaptureCtx {
  if (!ctx) throw new Error("Graph capture primitive used outside capture()");
  return ctx;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export type CaptureOptions = {
  sampleRate: number;
  renderQuantum?: number;
};

export type ProcessorBodyForCapture = (capCtx: {
  sampleRate: number;
  renderQuantum: number;
}) => { process: () => void };

export function capture(
  body: ProcessorBodyForCapture,
  opts: CaptureOptions,
): CapturedGraph {
  if (ctx) throw new Error("Reentrant capture() not allowed");
  const renderQuantum = opts.renderQuantum ?? 128;
  const c = new CaptureCtx({ sampleRate: opts.sampleRate, renderQuantum });
  ctx = c;
  try {
    const ret = body({ sampleRate: c.sampleRate, renderQuantum: c.renderQuantum });
    if (!ret || typeof ret.process !== "function") {
      throw new Error("defineProcessor body must return { process }");
    }
    c.inProcessBody = true;
    c.rootScope().declared = true;
    ret.process();
    c.inProcessBody = false;

    // Collect message handlers from the side-channel maps into the graph.
    for (const [messageId, handlers] of c.messageHandlerBodies) {
      for (const h of handlers) {
        c.graph.messageHandlers.push({
          messageId,
          body: h.body,
          payloadFields: h.payloadFields,
          varField: h.varField,
        });
      }
    }
    for (const [midiInputId, byType] of c.midiHandlerBodies) {
      for (const [eventType, body] of byType) {
        c.graph.midiHandlers.push({
          midiInputId,
          eventType: eventType as any,
          body,
        });
      }
    }

    // The processBody is whatever ended up at the bottom of the body stack.
    c.graph.processBody = c.bodyStack[0]!;
    c.graph.schemaHash = computeSchemaHash(c.graph);
    return c.graph;
  } finally {
    ctx = null;
  }
}

// ─── Schema hash ─────────────────────────────────────────────────────────────

function computeSchemaHash(g: CapturedGraph): string {
  const parts: string[] = [];
  for (const s of g.declarations.states) {
    parts.push(`s|${s.path}|${s.type}|${policyKey(s.snapshot)}`);
  }
  for (const b of g.declarations.buffers) {
    parts.push(`b|${b.path}|${b.type}|${b.size}|${policyKey(b.snapshot)}`);
  }
  for (const p of g.declarations.params) {
    parts.push(
      `p|${p.name}|${p.automationRate}|${p.default}|${p.min}|${p.max}|${policyKey(
        p.snapshot,
      )}`,
    );
  }
  parts.sort();
  let h = 0x811c9dc5 >>> 0;
  const s = parts.join(";");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function policyKey(p: SnapshotPolicy): string {
  if (typeof p === "string") return p;
  return Object.entries(p)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`)
    .join(",");
}

// ─── Numeric literal lifting helpers ────────────────────────────────────────

// During capture, primitive args may be plain JS numbers/booleans. We lift
// them to ConstScalar nodes. Numeric literals default to f32 (per docs/00 §4).
export function lift(
  v: number | boolean | ASTValue,
  targetType?: AnyType,
): ASTValue {
  if (typeof v === "number") {
    const c = getCtx();
    return c.fresh({
      kind: "const",
      type: (targetType as ScalarType) ?? "f32",
      value: v,
    });
  }
  if (typeof v === "boolean") {
    const c = getCtx();
    return c.fresh({
      kind: "const",
      type: "bool",
      value: v,
    });
  }
  return v;
}

// Pick a result type for a binary arithmetic primitive.
//
// Per docs/00-foundations.md §4 "no implicit widening": the rule applies
// within the float family (f32 ↔ f64 and i32 ↔ i64). Cross-family conversion
// (i32 ↔ f32) is allowed and auto-widens to the float type — that's the
// natural arithmetic behavior expected by most processors (e.g. integer note
// states + float Hz computation).
export function arithType(a: ASTValue, b: ASTValue): ScalarType {
  const aType = a.type;
  const bType = b.type;

  // Const narrowing: a numeric literal (default f32) keeps its hint type, but
  // can be coerced to the non-const's type when it does not lose value.
  // - Const value is integer-representable AND non-const is int → narrow to int.
  // - Const value is fractional → widen non-const to float instead.
  if (a.kind === "const" && b.kind !== "const") {
    return adaptConstAgainstNonConst(a, bType as ScalarType);
  }
  if (b.kind === "const" && a.kind !== "const") {
    return adaptConstAgainstNonConst(b, aType as ScalarType);
  }
  if (aType === bType) return aType as ScalarType;

  // Cross-family widening rules
  const isFloat = (t: any) => t === "f32" || t === "f64";
  const isInt = (t: any) => t === "i32" || t === "i64";
  // Within float family: precision mismatch is an error
  if (isFloat(aType) && isFloat(bType)) {
    throw new Error(
      `Type mismatch in arithmetic: ${aType} vs ${bType}. unworklet does not implicitly widen between float precisions — use f32(node) or f64(node) at the boundary.`,
    );
  }
  // Within int family: precision mismatch is an error
  if (isInt(aType) && isInt(bType)) {
    throw new Error(
      `Type mismatch in arithmetic: ${aType} vs ${bType}. unworklet does not implicitly widen between integer precisions — use i32(node) or i64(node) at the boundary.`,
    );
  }
  // Cross-family: int + float → float (auto-widen integer to float)
  if (isFloat(aType) && isInt(bType)) return aType as ScalarType;
  if (isInt(aType) && isFloat(bType)) return bType as ScalarType;
  // Boolean: with int or float, treat bool as i32 (1=true, 0=false)
  if (aType === "bool") return bType as ScalarType;
  if (bType === "bool") return aType as ScalarType;
  throw new Error(`unhandled arith type combination ${aType} vs ${bType}`);
}

function adaptConstAgainstNonConst(constant: ASTValue, nonConstType: ScalarType): ScalarType {
  if (constant.kind !== "const") return nonConstType;
  const v = (constant as any).value;
  const isFloatType = (t: any) => t === "f32" || t === "f64";
  const isIntType = (t: any) => t === "i32" || t === "i64";
  if (isIntType(nonConstType)) {
    // If the constant is an integer-representable number, narrow it.
    // Otherwise (fractional float literal), widen non-const to float.
    if (typeof v === "number" && Number.isInteger(v)) {
      (constant as any).type = nonConstType;
      return nonConstType;
    }
    return "f32";
  }
  if (isFloatType(nonConstType)) {
    (constant as any).type = nonConstType;
    return nonConstType;
  }
  if (nonConstType === "bool") {
    (constant as any).type = "bool";
    return "bool";
  }
  return nonConstType;
}

export function narrowConst(c: ASTValue, t: ScalarType): ASTValue {
  if (c.kind === "const" && c.type !== t) {
    return { ...(c as any), type: t };
  }
  return c;
}
