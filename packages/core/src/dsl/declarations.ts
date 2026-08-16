/**
 * Declaration helpers (`01-dsl.md` §1 / §3 / §4 + `11-midi.md` §1).
 *
 * Declaration scope only: each helper registers a slot in the graph and
 * a region in WASM linear memory (state / buffer / param / event / message /
 * MIDI input / MIDI output).
 *
 * Named-factory chain (= Q79): `.named('X')` quick form / `.expose({ name, ... })`
 * full form are exposed both **before** the type method (`state.named('X').f32(0)`)
 * and **after** (`state.f32(0).named('X')`). Field merge = after-wins.
 */

import type {
  AstNode,
  BufferDecl,
  EventDeclAst,
  EventEmitField,
  MessageDeclAst,
  MidiByteField,
  MidiInputDecl,
  MidiOutputDecl,
  ParamDecl,
  StateDecl,
} from "../compile/ast.ts";
import { inferAstType } from "../compile/ast.ts";
import { SAMPLES_PER_BLOCK } from "./constants.ts";
import {
  addDeclaration,
  addStatement,
  captureTemp,
  getCurrentCapture,
  isWrappedNode,
  unwrapAst,
  wrapAst,
} from "../compile/capture.ts";
import {
  PAYLOAD_FIELD_META,
  type PayloadFieldMeta,
  payloadFieldMeta,
  sealInboundFieldBool,
} from "./payload-field.ts";
import type {
  AudioInputHandle,
  AudioOutputHandle,
  Buffer,
  BufferElementType,
  Capacity,
  EventDecl,
  ExposeOptions,
  InputChannelView,
  MessageDecl,
  MidiEventGraph,
  MidiEventType,
  MidiInputHandle,
  MidiOutputHandle,
  Node,
  NoiseSource,
  NoiseSourceOptions,
  OutputChannelView,
  Param,
  ScalarOf,
  ScalarType,
  State,
  TypedArrayFieldRef,
} from "../types.ts";

/**
 * Inbound sysex `data` proxy (= `TypedArrayFieldRef<'u8'>`) hidden marker: the
 * source MIDI port whose current drain-slot content chunk holds the bytes.
 * `buf.copyFrom(data)` reads this to emit a `midiSysexCopy` (`11-midi.md` §2.5).
 */
const MIDI_SYSEX_META = Symbol("unworklet.midiSysexMeta");

type MidiSysexMeta = { port: string };

const midiSysexMeta = (v: unknown): MidiSysexMeta | undefined =>
  typeof v === "object" && v !== null
    ? (v as Record<symbol, MidiSysexMeta | undefined>)[MIDI_SYSEX_META]
    : undefined;

/**
 * Hidden identity attached to a buffer handle (= name + element type). A marker
 * that lets `event.emitIf` detect a buffer passed as a typed-array field's value
 * (= the emit side of the §4.3 worklet→main path). An internal symbol that never
 * appears on the public `Buffer<T>` type.
 */
const BUFFER_HANDLE_META = Symbol("unworklet.bufferHandleMeta");

type BufferHandleMeta = { decl: BufferDecl };

const bufferHandleMeta = (v: unknown): BufferHandleMeta | undefined =>
  typeof v === "object" && v !== null
    ? (v as Record<symbol, BufferHandleMeta | undefined>)[BUFFER_HANDLE_META]
    : undefined;

// ─────────────────────────────────────────────────────────────────────────
// Literal lift helpers (= Q36-a)
// ─────────────────────────────────────────────────────────────────────────

function liftOffset(i: Node<"i32"> | number): AstNode {
  if (typeof i === "number") {
    return { kind: "literal", type: "i32", value: i };
  }
  return unwrapAst(i);
}

/**
 * Lift a sample offset for an audio I/O / `param` `.at(k)` access, range-checking
 * a JS-literal offset against `[0, SAMPLES_PER_BLOCK - 1]` (= 0..127, Q68). A
 * `Node<'i32'>` offset (= a `forSample` loop counter or computed index) is
 * unrestricted — only compile-time-literal offsets are bounded here. Stable ID
 * `audio-sample-offset-out-of-range`.
 */
function liftSampleOffset(i: Node<"i32"> | number, ctx: string): AstNode {
  if (typeof i === "number" && (!Number.isInteger(i) || i < 0 || i >= SAMPLES_PER_BLOCK)) {
    throw new Error(
      `unworklet: ${ctx} sample offset ${i} is out of range [0, ${SAMPLES_PER_BLOCK - 1}] ` +
        `(JS-literal offsets must be an integer within the render quantum; use a forSample ` +
        `loop counter for per-sample access). (stable ID 'audio-sample-offset-out-of-range')`,
    );
  }
  return liftOffset(i);
}

function liftF32(v: Node<"f32"> | number): AstNode {
  if (typeof v === "number") {
    return { kind: "literal", type: "f32", value: v };
  }
  return unwrapAst(v);
}

/**
 * Lift the value argument of `state.<type>.write(v)` to an AST (= Q33 literal lift
 * + `Node<T>` unwrap). i64 requires a bigint; bool converts boolean → i32 0/1 as
 * its internal representation (= Q42, matching the bool case in emit.ts). The
 * existing `literal` kind in ast.ts constrains `value: number`, so storing an i64
 * literal as a bigint is filled in by a later sub-phase together with the literal
 * type extension.
 */
function liftStoreValue<T extends ScalarType>(type: T, v: Node<T> | ScalarOf<T>): AstNode {
  // A bare inbound `boolean` payload field written to a `state.bool` slot seals
  // its wire type to bool (it defaults to f32; a `number` field never reaches a
  // bool slot, so it keeps the f32 default). No-op for any other value.
  if (type === "bool") sealInboundFieldBool(v);
  if (typeof v === "number") {
    return { kind: "literal", type, value: v };
  }
  if (typeof v === "boolean") {
    // bool uses an i32 internal representation (= an i32.store on the store path).
    return { kind: "literal", type: "i32", value: v ? 1 : 0 };
  }
  if (typeof v === "bigint") {
    // i64 literal store: carry the bigint directly on the literal node (= emit
    // splits it into 32-bit words for `i64.const`). A value arriving via
    // `Node<'i64'>` (= stateLoad etc.) follows the same path.
    return { kind: "literal", type: "i64", value: v };
  }
  // A node's scalar type is TS-guaranteed to match the slot, so it passes through.
  return unwrapAst(v as Node<ScalarType>);
}

// ─────────────────────────────────────────────────────────────────────────
// `state` — scalar slots (`01-dsl.md` §3.1)
// ─────────────────────────────────────────────────────────────────────────

type StateFactory<T extends ScalarType> = (initial: ScalarOf<T>) => State<T>;

export interface StateChain {
  readonly f32: StateFactory<"f32">;
  readonly f64: StateFactory<"f64">;
  readonly i32: StateFactory<"i32">;
  readonly i64: StateFactory<"i64">;
  readonly bool: StateFactory<"bool">;
  named(name: string): StateChain;
  expose(options: ExposeOptions): StateChain;
}

// `state` chain (= Q79 chain-order free + Q76 plain factory + Q42 publish
// type restriction). The chain accumulates `.named('X')` /
// `.expose({ name, snapshot, publish })` into pendingExpose (= field after-wins
// merge), and the type method (= `.f32(0)` etc.) runs makeStateDecl to create
// the decl. Post-hoc `.named` / `.expose` on the handle mutate the decl with the
// same merge logic.
//
// The name field of the AST shape closure-captures `decl.name` at the point of
// the `.read()` / `.write()` call (= late binding), matching the order in which
// a post-chain fix takes effect (= same discipline as param: the chain must be
// completed before any store/load call = user's responsibility).
//
// Validation timing is eager (= per chain method), so an invalid chain is
// rejected early, mid-chain.

const EMPTY_EXPOSE: ExposeOptions = {};

function mergeExpose(prev: ExposeOptions, next: ExposeOptions): ExposeOptions {
  return {
    name: next.name ?? prev.name,
    snapshot: next.snapshot ?? prev.snapshot,
    publish: next.publish ?? prev.publish,
  };
}

const makeStateChain = (pendingExpose: ExposeOptions): StateChain => ({
  f32: (initial) => makeStateDecl("f32", initial, pendingExpose),
  f64: (initial) => makeStateDecl("f64", initial, pendingExpose),
  i32: (initial) => makeStateDecl("i32", initial, pendingExpose),
  i64: (initial) => makeStateDecl("i64", initial, pendingExpose),
  bool: (initial) => makeStateDecl("bool", initial, pendingExpose),
  named: (name) => makeStateChain(mergeExpose(pendingExpose, { name })),
  expose: (options) => makeStateChain(mergeExpose(pendingExpose, options)),
});

/**
 * Name-uniqueness check for a state slot (= `01-dsl.md` §3.1 + Q5-b).
 *
 * Runs on both paths: at declaration time (= `state.f32(0)` /
 * `state.named('X').f32(0)`) and on a post-hoc .named() / .expose() mutation.
 * Passing `excludeDecl` excludes the decl itself from the check (= so the path
 * where .named() overwrites its own name does not falsely report a self-collision).
 * Names are unique within a kind = a collision occurs even across differing types.
 */
function checkStateName(name: string, excludeDecl: StateDecl | null = null): void {
  const ctx = getCurrentCapture();
  if (ctx.declarations.some((d) => d.kind === "state" && d.name === name && d !== excludeDecl)) {
    throw new Error(
      `unworklet: duplicate state declaration name "${name}" — state names must be unique within a processor`,
    );
  }
}

const PUBLISH_ALLOWED_TYPES: ReadonlySet<ScalarType> = new Set(["f32", "i32", "bool"]);

/**
 * Publish / snapshot consistency check for a state slot (= Q42 + `01-dsl.md` §3.1).
 * - publish + invalid type (f64 / i64) → throw
 * - publish + rateFps <= 0 (including NaN) → throw
 * - publish + userNamed = false (= synthetic name) → throw
 * - snapshot 'persistent' + userNamed = false → throw
 *
 * Runs eagerly (= per chain method), rejecting an invalid chain early.
 */
function validateStateDecl(decl: StateDecl): void {
  if (decl.publish !== undefined) {
    if (!PUBLISH_ALLOWED_TYPES.has(decl.type)) {
      throw new Error(
        `unworklet: publish is only supported on state.f32 / state.i32 / state.bool (= Q42), got state.${decl.type}`,
      );
    }
    if (!Number.isFinite(decl.publish.rateFps) || decl.publish.rateFps <= 0) {
      throw new Error(
        `unworklet: publish rateFps must be a positive finite number, got ${decl.publish.rateFps}`,
      );
    }
    if (!decl.userNamed) {
      throw new Error(
        `unworklet: state slot with publish requires user-defined name (= via .named('X') or .expose({ name: 'X' }))`,
      );
    }
  }
  if (decl.snapshot === "persistent" && !decl.userNamed) {
    throw new Error(
      `unworklet: state slot with snapshot 'persistent' requires user-defined name (= via .named('X') or .expose({ name: 'X' }))`,
    );
  }
}

function makeStateDecl<T extends ScalarType>(
  type: T,
  initial: ScalarOf<T>,
  pendingExpose: ExposeOptions,
): State<T> {
  const ctx = getCurrentCapture();
  const synthIdx = ctx.declarations.filter((d) => d.kind === "state").length;
  // A user name is prefixed with the subgraph instance prefix (= §5.6). An auto
  // name is already unique via the global synthIdx = no prefix needed.
  const name =
    pendingExpose.name !== undefined ? ctx.namePrefix + pendingExpose.name : `__state_${synthIdx}`;
  checkStateName(name);
  const decl: StateDecl = {
    kind: "state",
    name,
    type,
    initial: initial as number | bigint | boolean,
    userNamed: pendingExpose.name !== undefined,
    snapshot: pendingExpose.snapshot,
    publish: pendingExpose.publish,
  };
  validateStateDecl(decl);
  addDeclaration(decl);
  return makeStateHandle<T>(decl);
}

function makeStateHandle<T extends ScalarType>(decl: StateDecl): State<T> {
  const handle = {
    read: () =>
      // Eager temp-local capture freezes the slot value at this lexical point
      // (= `03-compiler.md` §2.7, issue #8) — a later `write` cannot change it.
      captureTemp<T>(
        {
          kind: "stateLoad",
          type: decl.type,
          name: decl.name,
        },
        decl.type,
      ),
    write: (v: Node<T> | ScalarOf<T>) => {
      addStatement({
        kind: "stateStore",
        type: decl.type,
        name: decl.name,
        value: liftStoreValue<T>(decl.type as T, v),
      });
    },
    named: (name: string) => {
      const fullName = getCurrentCapture().namePrefix + name;
      checkStateName(fullName, decl);
      decl.name = fullName;
      decl.userNamed = true;
      validateStateDecl(decl);
      return handle;
    },
    expose: (options: ExposeOptions) => {
      // A user name is prefixed with the subgraph instance prefix (= §5.6, same
      // axis as buffer / .named).
      const exposeName =
        options.name !== undefined ? getCurrentCapture().namePrefix + options.name : undefined;
      if (exposeName !== undefined && exposeName !== decl.name) {
        checkStateName(exposeName, decl);
        decl.name = exposeName;
        decl.userNamed = true;
      } else if (exposeName !== undefined) {
        // Re-setting the same name promotes the userNamed flag to true (= a
        // post-hoc .expose passing the same name as the decl itself = treated as
        // user-explicit).
        decl.userNamed = true;
      }
      if (options.snapshot !== undefined) {
        decl.snapshot = options.snapshot;
      }
      if (options.publish !== undefined) {
        decl.publish = options.publish;
      }
      validateStateDecl(decl);
      return handle;
    },
  } as unknown as State<T>;
  return handle;
}

// `state` (with its `state.buffer` array sub-namespace) is exported after the
// buffer chain is defined below.

// ─────────────────────────────────────────────────────────────────────────
// `buffer` — fixed-size arrays (`01-dsl.md` §3.2)
// ─────────────────────────────────────────────────────────────────────────

type BufferFactory<T extends BufferElementType> = (options: { size: number }) => Buffer<T>;

export interface BufferChain {
  readonly f32: BufferFactory<"f32">;
  readonly f64: BufferFactory<"f64">;
  readonly i32: BufferFactory<"i32">;
  readonly i64: BufferFactory<"i64">;
  readonly bool: BufferFactory<"bool">;
  readonly u8: BufferFactory<"u8">;
  named(name: string): BufferChain;
  expose(options: ExposeOptions): BufferChain;
}

/** The scalar type a buffer element surfaces as (= `u8` is accessed via i32). */
function bufferScalarType(t: BufferElementType): ScalarType {
  return t === "u8" ? "i32" : t;
}

/** Lift a buffer write value (= Q33 literal lift, element-type aware). */
function liftBufferValue(elementType: BufferElementType, v: Node<ScalarType> | number): AstNode {
  const st = bufferScalarType(elementType);
  // A bare inbound `boolean` payload field written into a `buffer.bool` seals its
  // wire type to bool (same axis as the state.bool write).
  if (st === "bool") sealInboundFieldBool(v);
  if (typeof v === "number") {
    return { kind: "literal", type: st, value: st === "i32" ? v | 0 : v };
  }
  // A node's scalar type is TS-guaranteed to match the element, so it passes through.
  return unwrapAst(v);
}

/**
 * Name-uniqueness check for a buffer slot (= `01-dsl.md` §3.2, same convention as
 * state). Unique within a kind (= a collision occurs even across differing types).
 * `excludeDecl` avoids a false self-collision on a post-hoc `.named`.
 */
function checkBufferName(name: string, excludeDecl: BufferDecl | null = null): void {
  const ctx = getCurrentCapture();
  if (ctx.declarations.some((d) => d.kind === "buffer" && d.name === name && d !== excludeDecl)) {
    throw new Error(
      `unworklet: duplicate buffer declaration name "${name}" — buffer names must be unique within a processor`,
    );
  }
}

/**
 * Publish / snapshot consistency check for a buffer slot (= `01-dsl.md` §3.2).
 * Same axis as state, but with no type restriction on publish (= publish is
 * allowed for every element type, Q27-a/e). A persistent snapshot / publish
 * requires a main-side identity = requires userNamed.
 */
function validateBufferDecl(decl: BufferDecl): void {
  if (decl.publish !== undefined) {
    if (!Number.isFinite(decl.publish.rateFps) || decl.publish.rateFps <= 0) {
      throw new Error(
        `unworklet: publish rateFps must be a positive finite number, got ${decl.publish.rateFps}`,
      );
    }
    if (!decl.userNamed) {
      throw new Error(
        `unworklet: buffer with publish requires user-defined name (= via .named('X') or .expose({ name: 'X' }))`,
      );
    }
  }
  if (decl.snapshot === "persistent" && !decl.userNamed) {
    throw new Error(
      `unworklet: buffer with snapshot 'persistent' requires user-defined name (= via .named('X') or .expose({ name: 'X' }))`,
    );
  }
}

function makeBufferDecl<T extends BufferElementType>(
  type: T,
  size: number,
  pendingExpose: ExposeOptions,
): Buffer<T> {
  const ctx = getCurrentCapture();
  const synthIdx = ctx.declarations.filter((d) => d.kind === "buffer").length;
  // A user name is prefixed with the subgraph instance prefix (= §5.6, same axis
  // as state). An auto name is already unique via the global synthIdx = no prefix
  // needed. Named buffers do not collide across multiple instances.
  const name =
    pendingExpose.name !== undefined ? ctx.namePrefix + pendingExpose.name : `__buffer_${synthIdx}`;
  checkBufferName(name);
  const decl: BufferDecl = {
    kind: "buffer",
    name,
    type,
    size,
    userNamed: pendingExpose.name !== undefined,
    snapshot: pendingExpose.snapshot,
    publish: pendingExpose.publish,
  };
  validateBufferDecl(decl);
  addDeclaration(decl);
  return makeBufferHandle<T>(decl);
}

function makeBufferHandle<T extends BufferElementType>(decl: BufferDecl): Buffer<T> {
  // Range-check a literal index / offset at graph-capture time (= §3.2: literal
  // range constraints are rejected at capture). A dynamic `Node<'i32'>` is the
  // caller's responsibility (= no check). `lanes` is the count of contiguous
  // elements a SIMD load/store touches (= 1 for read/write, 4 for loadVec/storeVec).
  const liftIndex = (idx: Node<"i32"> | number, op: string, lanes = 1): AstNode => {
    if (typeof idx === "number") {
      if (!Number.isInteger(idx) || idx < 0 || idx + lanes > decl.size) {
        throw new Error(
          `unworklet: buffer "${decl.name}" ${op}(${idx}) index is out of range [0, ${decl.size - lanes + 1}) (literal buffer indexes are range-checked at graph capture; use a Node<'i32'> for runtime indexing)`,
        );
      }
      return { kind: "literal", type: "i32", value: idx };
    }
    return unwrapAst(idx);
  };
  const handle = {
    get size() {
      return decl.size;
    },
    get name() {
      return decl.name;
    },
    read: (idx: Node<"i32"> | number) =>
      // Eager temp-local capture (= issue #8): a later `write` to the same
      // index cannot change what an already-bound read `Node` evaluates to.
      captureTemp(
        {
          kind: "bufferRead",
          elementType: decl.type,
          name: decl.name,
          index: liftIndex(idx, "read"),
        },
        decl.type === "u8" ? "i32" : decl.type,
      ),
    write: (idx: Node<"i32"> | number, v: Node<ScalarType> | number) => {
      addStatement({
        kind: "bufferWrite",
        elementType: decl.type,
        name: decl.name,
        index: liftIndex(idx, "write"),
        value: liftBufferValue(decl.type, v),
      });
    },
    readInterpolated: (pos: Node<"f32"> | number) => {
      // Interpolation reads the 2-tap pair floor(pos) and floor(pos)+1, so a
      // literal pos must be within [0, size-1).
      if (typeof pos === "number" && (!(pos >= 0) || pos >= decl.size - 1)) {
        throw new Error(
          `unworklet: buffer "${decl.name}" readInterpolated(${pos}) pos is out of range [0, ${decl.size - 1}) (= 2-tap interpolation reads up to floor(pos)+1; a literal pos is range-checked at capture)`,
        );
      }
      return captureTemp(
        {
          kind: "bufferReadInterpolated",
          elementType: decl.type,
          name: decl.name,
          pos: liftF32(pos),
        },
        decl.type === "u8" ? "i32" : decl.type,
      );
    },
    copyFrom: (src: TypedArrayFieldRef<T>) => {
      // Inbound sysex `data` proxy → bulk copy the port's content chunk into this
      // buffer (= `11-midi.md` §2.5 ingest path). u8 buffer only.
      const sysexSrc = midiSysexMeta(src);
      if (sysexSrc !== undefined) {
        if (decl.type !== "u8") {
          throw new Error(
            `unworklet: buffer "${decl.name}".copyFrom(sysex data) requires a buffer.u8 (got '${decl.type}'). (stable ID 'payload-element-type-mismatch')`,
          );
        }
        addStatement({
          kind: "midiSysexCopy",
          port: sysexSrc.port,
          bufferName: decl.name,
          bufferSize: decl.size,
        });
        return;
      }
      const meta = payloadFieldMeta(src);
      if (meta === undefined) {
        throw new Error(
          "unworklet: buffer.copyFrom(src) requires a typed-array message payload field",
        );
      }
      // Typed-array-seal the field with the dest buffer's element type (= since the
      // T of `TypedArrayFieldRef<T>` is type-constrained to match the buffer type,
      // reserve a payloadContent + 8-byte slot).
      const field = meta.decl.fields.find((f) => f.name === meta.field);
      if (field !== undefined) {
        // Layer 2 backstop (Q31-c): the field's element type was already sealed
        // (e.g. read via `.at()` = f32) to a type that disagrees with this
        // buffer's element type. The TS binding prevents the well-typed case;
        // this catches a bypassed binding before a mis-sized memory.copy.
        if (field.payloadElementType !== undefined && field.payloadElementType !== decl.type) {
          throw new Error(
            `unworklet: buffer "${decl.name}".copyFrom(${meta.decl.name}.${meta.field}) element ` +
              `type mismatch — field is '${field.payloadElementType}', buffer is '${decl.type}'. ` +
              `(stable ID 'payload-element-type-mismatch')`,
          );
        }
        field.payloadElementType = decl.type;
        // The typed-array slot is [payloadLen, payloadOffset]; pin the unused scalar
        // wireType to the canonical `i32` dummy (same as the `.at()`/`.length` seal).
        field.wireType = "i32";
      }
      addStatement({
        kind: "bufferCopyFrom",
        elementType: decl.type,
        bufferName: decl.name,
        bufferSize: decl.size,
        messageName: meta.decl.name,
        field: meta.field,
      });
    },
    // SIMD buffer I/O (= §7; the type is restricted to f32 via the declaration
    // merge in @unworklet/core/simd). The offset is in element units = ×4 bytes on
    // the emit side. Load/store 4 lanes as a v128.
    loadVec: (offset: Node<"i32"> | number) =>
      wrapAst<"f32x4">({
        kind: "bufferLoadVec",
        name: decl.name,
        offset: liftIndex(offset, "loadVec", 4),
      }),
    storeVec: (offset: Node<"i32"> | number, value: Node<"f32x4">) => {
      addStatement({
        kind: "bufferStoreVec",
        name: decl.name,
        offset: liftIndex(offset, "storeVec", 4),
        value: unwrapAst(value),
      });
    },
    named: (name: string) => {
      const fullName = getCurrentCapture().namePrefix + name;
      checkBufferName(fullName, decl);
      decl.name = fullName;
      decl.userNamed = true;
      validateBufferDecl(decl);
      return handle;
    },
    expose: (options: ExposeOptions) => {
      const exposeName =
        options.name !== undefined ? getCurrentCapture().namePrefix + options.name : undefined;
      if (exposeName !== undefined && exposeName !== decl.name) {
        checkBufferName(exposeName, decl);
        decl.name = exposeName;
        decl.userNamed = true;
      } else if (exposeName !== undefined) {
        decl.userNamed = true;
      }
      if (options.snapshot !== undefined) {
        decl.snapshot = options.snapshot;
      }
      if (options.publish !== undefined) {
        decl.publish = options.publish;
      }
      validateBufferDecl(decl);
      return handle;
    },
  } as unknown as Buffer<T>;
  // A marker by which event.emitIf identifies a buffer passed as a typed-array
  // field's value (= §4.3 worklet→main; via the decl reference, a late-bound name
  // is also tracked).
  Object.defineProperty(handle, BUFFER_HANDLE_META, {
    value: { decl } satisfies BufferHandleMeta,
    enumerable: false,
  });
  return handle;
}

const makeBufferChain = (pendingExpose: ExposeOptions): BufferChain => ({
  f32: ({ size }) => makeBufferDecl("f32", size, pendingExpose),
  f64: ({ size }) => makeBufferDecl("f64", size, pendingExpose),
  i32: ({ size }) => makeBufferDecl("i32", size, pendingExpose),
  i64: ({ size }) => makeBufferDecl("i64", size, pendingExpose),
  bool: ({ size }) => makeBufferDecl("bool", size, pendingExpose),
  u8: ({ size }) => makeBufferDecl("u8", size, pendingExpose),
  named: (name) => makeBufferChain(mergeExpose(pendingExpose, { name })),
  expose: (options) => makeBufferChain(mergeExpose(pendingExpose, options)),
});

const bufferChain: BufferChain = makeBufferChain(EMPTY_EXPOSE);

// `state` carries the scalar factory chain plus `state.buffer` — the array form
// of state (Q76 buffer = the array form of state). `state.buffer` is the only place the
// buffer chain is reachable; `state.named(...)` returns a plain `StateChain`.
export const state: StateChain & { readonly buffer: BufferChain } = Object.assign(
  makeStateChain(EMPTY_EXPOSE),
  { buffer: bufferChain },
);

// ─────────────────────────────────────────────────────────────────────────
// `param` — AudioParam-backed (`01-dsl.md` §3.3 + Q76 named-only)
// ─────────────────────────────────────────────────────────────────────────

export type ParamOptions = {
  default: number;
  min: number;
  max: number;
  automationRate: "a-rate" | "k-rate";
  unit?: string;
};

type ParamFactory = (options: ParamOptions) => Param;

export interface ParamChain {
  readonly f32: ParamFactory;
  named(name: string): ParamChain;
  expose(options: ExposeOptions): ParamChain;
}

// `param` chain (= Q76 named-required + Q79 chain-order free).
// `.f32(opts)` appends the declaration to the graph, and the chain's `.named()` /
// `.expose({...})` — whether post-hoc or pre-hoc — point at the same declaration
// (= after-wins, mutate). `param.at(i)` reads decl.name via late-binding = it
// reflects the latest name even after repeated `.named` / `.expose`. The snapshot
// policy is set via `.expose({ snapshot })` (default 'persistent').

const makeParamChain = (pending: ExposeOptions): ParamChain => ({
  f32: (options) => {
    const decl: ParamDecl = {
      kind: "param",
      name: pending.name ?? "",
      type: "f32",
      default: options.default,
      min: options.min,
      max: options.max,
      automationRate: options.automationRate,
      snapshot: pending.snapshot,
    };
    addDeclaration(decl);
    return makeParam(decl);
  },
  named: (name) => makeParamChain(mergeExpose(pending, { name })),
  expose: (options) => makeParamChain(mergeExpose(pending, options)),
});

function makeParam(decl: ParamDecl): Param {
  const handle = {
    at: (i: Node<"i32"> | number) =>
      wrapAst<"f32">({
        kind: "paramAt",
        paramName: decl.name,
        offset: liftSampleOffset(i, `param "${decl.name}".at(...)`),
      }),
    named: (name: string) => {
      decl.name = name;
      return handle;
    },
    expose: (options: ExposeOptions) => {
      if (options.name !== undefined) decl.name = options.name;
      if (options.snapshot !== undefined) decl.snapshot = options.snapshot;
      return handle;
    },
  } as unknown as Param;
  return handle;
}

export const param: ParamChain = makeParamChain(EMPTY_EXPOSE);

// ─────────────────────────────────────────────────────────────────────────
// Audio I/O declarations (`01-dsl.md` §1.1)
// ─────────────────────────────────────────────────────────────────────────

function makeInputView(portName: string, channel: number): InputChannelView<"f32"> {
  return {
    at: (i) =>
      wrapAst<"f32">({
        kind: "audioInRead",
        portName,
        channel,
        offset: liftSampleOffset(i, `audioInput "${portName}".at(...)`),
      }),
  };
}

function makeOutputView(portName: string, channel: number): OutputChannelView<"f32"> {
  return {
    at: (i) => ({
      write: (v) => {
        addStatement({
          kind: "audioOutWrite",
          portName,
          channel,
          offset: liftSampleOffset(i, `audioOutput "${portName}".at(...)`),
          value: liftF32(v),
        });
      },
    }),
  };
}

/**
 * Define `.left` / `.right` on a non-stereo port as throwing getters. The `.ts`
 * handle type already omits them unless `channels` is 2, but the `.uwk.ts` sugar
 * path lowers `port.left[i]` without that type — so without this guard a mono
 * author hits an opaque `undefined` TypeError instead of being pointed at `.ch`.
 */
function defineStereoOnlyGuards(
  handle: Record<string, unknown>,
  kind: "audioInput" | "audioOutput",
  name: string,
  channels: number,
): void {
  for (const side of ["left", "right"] as const) {
    Object.defineProperty(handle, side, {
      get(): never {
        throw new Error(
          `${kind} "${name}" has ${channels} channel(s) — ".${side}" is stereo-only (channels: 2); use .ch(${side === "left" ? 0 : 1}).`,
        );
      },
      enumerable: false,
    });
  }
}

export function audioInput<C extends number>(options: {
  channels: C;
  name: string;
}): AudioInputHandle<C> {
  addDeclaration({
    kind: "audioInput",
    name: options.name,
    channels: options.channels,
  });
  const handle: Record<string, unknown> = {
    channels: options.channels,
    name: options.name,
    ch: (c: number) => makeInputView(options.name, c),
  };
  if (options.channels === 2) {
    Object.defineProperty(handle, "left", {
      get: () => makeInputView(options.name, 0),
      enumerable: true,
    });
    Object.defineProperty(handle, "right", {
      get: () => makeInputView(options.name, 1),
      enumerable: true,
    });
  } else {
    defineStereoOnlyGuards(handle, "audioInput", options.name, options.channels);
  }
  return handle as AudioInputHandle<C>;
}

export function audioOutput<C extends number>(options: {
  channels: C;
  name: string;
}): AudioOutputHandle<C> {
  addDeclaration({
    kind: "audioOutput",
    name: options.name,
    channels: options.channels,
  });
  const handle: Record<string, unknown> = {
    channels: options.channels,
    name: options.name,
    ch: (c: number) => makeOutputView(options.name, c),
  };
  if (options.channels === 2) {
    Object.defineProperty(handle, "left", {
      get: () => makeOutputView(options.name, 0),
      enumerable: true,
    });
    Object.defineProperty(handle, "right", {
      get: () => makeOutputView(options.name, 1),
      enumerable: true,
    });
  } else {
    defineStereoOnlyGuards(handle, "audioOutput", options.name, options.channels);
  }
  return handle as AudioOutputHandle<C>;
}

// ─────────────────────────────────────────────────────────────────────────
// `event<T>` / `message<T>` (`01-dsl.md` §4)
// ─────────────────────────────────────────────────────────────────────────

export type EventOptions = {
  name: string;
  capacity?: Capacity;
  payloadCapacity?: number;
};

export type MessageOptions = {
  name: string;
  capacity?: Capacity;
  payloadCapacity?: number;
};

const EVENT_DEFAULT_CAPACITY = 256;

/**
 * Name-uniqueness check for an `event<T>` declaration (= `01-dsl.md` §4.1).
 *
 * Names are unique within a kind = same pattern as state (= across kinds there is
 * no collision since they occupy separate physical layout regions, so only the
 * same kind is checked). Its primary purpose is to prevent key collisions on
 * `node.events.<name>`.
 */
function checkEventName(name: string): void {
  const ctx = getCurrentCapture();
  if (ctx.declarations.some((d) => d.kind === "event" && d.name === name)) {
    throw new Error(
      `unworklet: duplicate event declaration name "${name}" — event names must be unique within a processor`,
    );
  }
}

/**
 * For the second and later emit sites of an `event<T>`, check name + wire-type
 * consistency against the already-sealed fields (= `01-dsl.md` §4.1). A mismatch
 * is a graph-capture-time error (= stable ID `event-field-type-mismatch`). The
 * seal at the first emit site is done directly via `decl.fields.push` inside emitIf.
 */
function checkSealedEventField(decl: EventDeclAst, fieldName: string, wireType: ScalarType): void {
  const existing = decl.fields.find((f) => f.name === fieldName);
  if (existing === undefined) {
    throw new Error(
      `unworklet: event "${decl.name}" emit site introduces new field "${fieldName}" — all emit sites for the same event<T> must agree on field set (Q71 / event-field-type-mismatch)`,
    );
  }
  if (existing.wireType !== wireType) {
    throw new Error(
      `unworklet: event "${decl.name}" field "${fieldName}" wire-type mismatch — previously sealed as ${existing.wireType}, this emit site supplies ${wireType} (Q71 / event-field-type-mismatch)`,
    );
  }
}

// The checkSealedEventField counterpart for typed-array (variable-length) fields
// (= Q71). Rejects a later emit site that adds a typed-array field not sealed at
// the first site, or that changes the element type (= applies the same field-set
// agreement contract used for scalar fields to typed-array fields too).
function checkSealedTypedArrayField(
  decl: EventDeclAst,
  fieldName: string,
  elementType: BufferElementType,
): void {
  const existing = decl.fields.find((f) => f.name === fieldName);
  if (existing === undefined || existing.payloadElementType === undefined) {
    throw new Error(
      `unworklet: event "${decl.name}" emit site introduces new typed-array field "${fieldName}" — all emit sites for the same event<T> must agree on field set (Q71 / event-field-type-mismatch)`,
    );
  }
  if (existing.payloadElementType !== elementType) {
    throw new Error(
      `unworklet: event "${decl.name}" typed-array field "${fieldName}" element-type mismatch — previously sealed as ${existing.payloadElementType}, this emit site supplies ${elementType} (Q71 / event-field-type-mismatch)`,
    );
  }
}

/**
 * For one field at one emit site of `eventDecl.emitIf`, build its value AST and
 * infer the wire type.
 *
 * - `Node<T>` → get the wireType via unwrapAst + inferAstType
 * - `boolean` → literal { type: 'bool', value 0/1 path = internal i32 representation, wireType = 'bool' }
 * - `number` → if a wire type is already sealed, lift to it (= a later emit site's
 *   literal matches the first site's wire type); if unsealed, default-lift to f32
 *   (= the Q33 convention)
 *
 * Q71 docs convention: the wire type is fixed at the first emit site. A first emit
 * with only a literal = default f32 (= Q33 numeric literal → Node<'f32'>).
 */
function liftEmitFieldValue(
  decl: EventDeclAst,
  fieldName: string,
  raw: unknown,
): { ast: AstNode; wireType: ScalarType } {
  if (isWrappedNode(raw)) {
    const ast = unwrapAst(raw);
    // A `messageFieldRead` bakes in `wireType: "f32"` when the field is first
    // touched, and never follows a later seal — the emit path sidesteps that by
    // resolving the field from its declaration, but `inferAstType` returns the
    // stale snapshot. Forwarding an inbound field straight into an outbound event
    // therefore recorded f32 even after the source sealed to bool, so a consumer
    // who declared `boolean` on both sides received 1 / 0 typed `number`.
    // Resolve the same way emission does: from the source declaration.
    if (ast.kind === "messageFieldRead") {
      const source = getCurrentCapture().declarations.find(
        (d): d is MessageDeclAst => d.kind === "message" && d.name === ast.name,
      );
      const sourceField = source?.fields.find((f) => f.name === ast.field);
      if (sourceField !== undefined) return { ast, wireType: sourceField.wireType };
    }
    return { ast, wireType: inferAstType(ast) };
  }
  if (typeof raw === "boolean") {
    return {
      ast: { kind: "literal", type: "i32", value: raw ? 1 : 0 },
      wireType: "bool",
    };
  }
  if (typeof raw === "number") {
    const existing = decl.fields.find((f) => f.name === fieldName);
    const wireType = existing?.wireType ?? "f32";
    return { ast: { kind: "literal", type: wireType, value: raw }, wireType };
  }
  throw new Error(
    `unworklet: event "${decl.name}" field "${fieldName}" value must be Node<T>, number, or boolean (got ${typeof raw})`,
  );
}

function eventToMain<T>(options: EventOptions): EventDecl<T> {
  checkEventName(options.name);
  const decl: EventDeclAst = {
    kind: "event",
    name: options.name,
    capacity: options.capacity ?? EVENT_DEFAULT_CAPACITY,
    payloadCapacity: options.payloadCapacity,
    fields: [],
  };
  addDeclaration(decl);
  const handle = {
    name: decl.name,
    emitIf: (cond: Node<"bool"> | boolean, payload: Record<string, unknown>) => {
      // A bare inbound `boolean` field used as the emit condition seals it to bool.
      sealInboundFieldBool(cond);
      const condAst: AstNode = isWrappedNode(cond)
        ? unwrapAst(cond)
        : { kind: "literal", type: "i32", value: cond ? 1 : 0 };
      // atSample default lift (= option B):
      // - inside a forSample callback (= currentLoopBody !== null) → loopCounter Node
      // - at per-block top level (= currentLoopBody === null) → literal 0
      // A user override passes through unchanged (= Node<'i32'> | number). An invalid
      // type (= string etc.) throws. A handler-context default is added in a later
      // path (sub-phase 7.7 / 9).
      const atSampleRaw = payload.atSample;
      const atSampleAst: AstNode = isWrappedNode(atSampleRaw)
        ? unwrapAst(atSampleRaw)
        : typeof atSampleRaw === "number"
          ? { kind: "literal", type: "i32", value: atSampleRaw }
          : atSampleRaw === undefined
            ? getCurrentCapture().currentLoopBody !== null
              ? { kind: "loopCounter" }
              : { kind: "literal", type: "i32", value: 0 }
            : (() => {
                throw new Error(
                  `unworklet: event "${decl.name}" emit "atSample" must be Node<'i32'> or number`,
                );
              })();

      const allKeys = Object.keys(payload).filter((k) => k !== "atSample");
      // A typed-array field (§4.3 worklet→main) = one whose value is a buffer handle
      // (§5.1: at most one). The adjacent `length` field is framework-injected = the
      // copy length of that typed-array field = not treated as a wire field (= consumed).
      const taFieldName = allKeys.find((k) => bufferHandleMeta(payload[k]) !== undefined);
      const scalarKeys = allKeys.filter(
        (k) => k !== taFieldName && !(taFieldName !== undefined && k === "length"),
      );
      const emitFields: EventEmitField[] = [];
      const isFirstEmit = decl.fields.length === 0;
      for (const fieldName of scalarKeys) {
        const { ast, wireType } = liftEmitFieldValue(decl, fieldName, payload[fieldName]);
        if (isFirstEmit) {
          // The first emit = seal the full field set (= no duplicate fields are
          // received within one emit, since Object.keys is unique = OK).
          decl.fields.push({ name: fieldName, wireType });
        } else {
          checkSealedEventField(decl, fieldName, wireType);
        }
        emitFields.push({ name: fieldName, wireType, value: ast });
      }
      if (taFieldName !== undefined) {
        const bufMeta = bufferHandleMeta(payload[taFieldName])!;
        const elementType = bufMeta.decl.type;
        const lengthRaw = payload.length;
        const lengthAst: AstNode = isWrappedNode(lengthRaw)
          ? unwrapAst(lengthRaw)
          : typeof lengthRaw === "number"
            ? { kind: "literal", type: "i32", value: lengthRaw }
            : (() => {
                throw new Error(
                  `unworklet: event "${decl.name}" typed-array field "${taFieldName}" requires a "length" field (Node<'i32'> | number)`,
                );
              })();
        if (isFirstEmit) {
          decl.fields.push({ name: taFieldName, wireType: "i32", payloadElementType: elementType });
        } else {
          checkSealedTypedArrayField(decl, taFieldName, elementType);
        }
        emitFields.push({
          name: taFieldName,
          wireType: "i32", // dummy (= the slot is [payloadLen, payloadOffset], branched on by payloadElementType)
          value: { kind: "literal", type: "i32", value: 0 }, // placeholder (= unused)
          payloadElementType: elementType,
          bufferName: bufMeta.decl.name,
          bufferSize: bufMeta.decl.size, // emit clamps the copied byte count to the buffer boundary
          length: lengthAst,
        });
      }
      if (!isFirstEmit && emitFields.length !== decl.fields.length) {
        const missing = decl.fields.filter((f) => !emitFields.some((e) => e.name === f.name));
        /* v8 ignore next 8 — the extra-field path already throws in checkSealedEventField;
           only this missing.length > 0 path hits the field-count mismatch with no extras
           = the "subset emit" path, already covered by the "Q71: field-set shrink" test */
        if (missing.length > 0) {
          throw new Error(
            `unworklet: event "${decl.name}" emit site missing field(s) "${missing
              .map((m) => m.name)
              .join(
                ", ",
              )}" — all emit sites for the same event<T> must agree on field set (Q71 / event-field-type-mismatch)`,
          );
        }
      }

      addStatement({
        kind: "eventEmitIf",
        name: decl.name,
        cond: condAst,
        atSample: atSampleAst,
        fields: emitFields,
      });
    },
  } as unknown as EventDecl<T>;
  return handle;
}

const MESSAGE_DEFAULT_CAPACITY = 256;

/**
 * Name-uniqueness check for a `message<T>` declaration (= `01-dsl.md` §4.2).
 * Names are unique within a kind = same pattern as state / event.
 */
function checkMessageName(name: string): void {
  const ctx = getCurrentCapture();
  if (ctx.declarations.some((d) => d.kind === "message" && d.name === name)) {
    throw new Error(
      `unworklet: duplicate message declaration name "${name}" — message names must be unique within a processor`,
    );
  }
}

/**
 * Payload proxy for an `onReceive` handler (= Q46 uniform lift).
 *
 * When the user destructures with `({ slot, gain }) => ...`, proxy.get(prop)
 * picks up each field name and returns a `Node<'i32'>` (= the field-type-erasure
 * path = a uniform lift for every number field; boolean / typed-array are filled
 * in by a later sub-phase). It simultaneously pushes onto decl.fields (= sealed
 * at the first onReceive, so repeated accesses of the same field name in later
 * onReceive calls all resolve to the same wire type).
 */
/**
 * Return the fields an `onReceive` handler touches via destructuring as a hybrid
 * handle. Scalar use (= `state.write(field)` etc.) behaves as a Node<'i32'>, while
 * typed-array use (= `field.at(i)` / `field.length`) exposes the `01-dsl.md` §4.3
 * proxy. A field's wire kind is sealed by "which interface was used" (= TS's
 * 2-view means user code consistently uses only one of them). The typed-array
 * element type is fixed to f32 in v1.0.0-a (= a Float32Array audio payload;
 * Uint8Array/u8 = sysex belongs to MIDI scope).
 */
function makeMessagePayloadProxy(decl: MessageDeclAst): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get(_target, prop): unknown {
        /* v8 ignore next 2 — defensive symbol access guard (= the destructure path
           only hits string keys) */
        if (typeof prop !== "string") return undefined;
        const fieldName = prop;
        // Stay consistent with the already-sealed field = repeated accesses resolve
        // to the same field; if unsealed, push as f32 (= the inbound number wire is
        // f32 so fractional values survive; a boolean field is delivered as 0.0/1.0
        // and converts to bool at its use site).
        if (!decl.fields.some((f) => f.name === fieldName)) {
          decl.fields.push({ name: fieldName, wireType: "f32" });
        }
        const sealTypedArray = (): void => {
          const field = decl.fields.find((f) => f.name === fieldName);
          if (field !== undefined) {
            field.payloadElementType = "f32";
            // A typed-array field's slot is [payloadLen, payloadOffset]; its scalar
            // wireType is an unused dummy. Pin it to the canonical `i32` (matching
            // the outbound event typed-array dummy) so the f32 scalar default does
            // not churn the schemaHash of a typed-array-only processor.
            field.wireType = "i32";
          }
        };
        // scalar view = a Node holding a messageFieldRead f32 as its astPayload.
        const node = wrapAst<"f32">({
          kind: "messageFieldRead",
          name: decl.name,
          field: fieldName,
          wireType: "f32",
        }) as unknown as Record<string, unknown>;
        // typed-array view (= §4.3 proxy). The field is typed-array-sealed the moment it is accessed.
        Object.defineProperty(node, "length", {
          get() {
            sealTypedArray();
            return wrapAst<"i32">({
              kind: "payloadFieldLength",
              messageName: decl.name,
              field: fieldName,
              elementType: "f32",
            });
          },
        });
        node["at"] = (idx: Node<"i32"> | number): Node<"f32"> => {
          sealTypedArray();
          return wrapAst<"f32">({
            kind: "payloadFieldRead",
            messageName: decl.name,
            field: fieldName,
            elementType: "f32",
            index: liftOffset(idx),
          });
        };
        // For `buf.copyFrom(field)` = hidden-carry the field's owning message + field
        // name (= the buffer handle builds the bufferCopyFrom AST from this, and the
        // seal is done on that side).
        Object.defineProperty(node, PAYLOAD_FIELD_META, {
          value: { decl, field: fieldName } satisfies PayloadFieldMeta,
          enumerable: false,
        });
        return node;
      },
    },
  );
}

function eventFromMain<T>(options: MessageOptions): MessageDecl<T> {
  checkMessageName(options.name);
  const decl: MessageDeclAst = {
    kind: "message",
    name: options.name,
    capacity: options.capacity ?? MESSAGE_DEFAULT_CAPACITY,
    payloadCapacity: options.payloadCapacity,
    fields: [],
  };
  addDeclaration(decl);
  const handle = {
    name: decl.name,
    onReceive(handler: (payload: Record<string, unknown>) => void) {
      // Build-time-eval the handler body into an AST, matching the forSample path
      // (= swap currentLoopBody to a sub-list to collect, then restore and push).
      const ctx = getCurrentCapture();
      const handlerBody: AstNode[] = [];
      const prev = ctx.currentLoopBody;
      ctx.currentLoopBody = handlerBody;
      try {
        handler(makeMessagePayloadProxy(decl));
      } finally {
        ctx.currentLoopBody = prev;
      }
      addStatement({ kind: "messageOnReceive", name: decl.name, body: handlerBody });
    },
  } as unknown as MessageDecl<T>;
  return handle;
}

// ─────────────────────────────────────────────────────────────────────────
// MIDI declarations (`11-midi.md` §1)
// ─────────────────────────────────────────────────────────────────────────

export type MidiPortOptions = {
  name: string;
  capacity?: Capacity;
};

const MIDI_DEFAULT_CAPACITY = 256;

/** Lift a `Node<'i32'> | number` to an AST node (i32 literal for numbers). */
function liftI32(v: Node<"i32"> | number): AstNode {
  return typeof v === "number" ? { kind: "literal", type: "i32", value: v | 0 } : unwrapAst(v);
}

const I32_ZERO: AstNode = { kind: "literal", type: "i32", value: 0 };

/**
 * A decoded MIDI drain-slot field as a graph `Node<'i32'>`. Eager-captured into
 * a temp local at the handler's start (= `captureTemp`, same path as issue #8):
 * the slot pointer (EVENT_SLOT_PTR_LOCAL) is reused by any `emitIf` later in the
 * handler, so freezing the field value up front keeps reads correct across an
 * intervening emit.
 */
function midiField(field: MidiByteField): Node<"i32"> {
  return captureTemp<"i32">({ kind: "midiFieldRead", field }, "i32");
}

/**
 * Build the `MidiEventGraph` an inbound `onEvent(type, handler)` receives: each
 * semantic field maps to the decoded drain-slot byte for that event type
 * (`11-midi.md` §2.2 / §4.1). The `sysex` variant's `data` proxy reads the
 * port's content region (`port` identifies it).
 */
function makeMidiEventProxy(eventType: MidiEventType, port: string): MidiEventGraph {
  const channel = midiField("channel");
  const atSample = midiField("atSample");
  switch (eventType) {
    case "noteOn":
    case "noteOff":
      return {
        type: eventType,
        channel,
        note: midiField("data1"),
        velocity: midiField("data2"),
        atSample,
      };
    case "cc":
      return {
        type: "cc",
        channel,
        controller: midiField("data1"),
        value: midiField("data2"),
        atSample,
      };
    case "pitchBend":
      return { type: "pitchBend", channel, value: midiField("pitchBend14"), atSample };
    case "programChange":
      return { type: "programChange", channel, program: midiField("data1"), atSample };
    case "channelPressure":
      return { type: "channelPressure", channel, pressure: midiField("data1"), atSample };
    case "aftertouch":
      return {
        type: "aftertouch",
        channel,
        note: midiField("data1"),
        pressure: midiField("data2"),
        atSample,
      };
    case "systemRealtime":
      return { type: "systemRealtime", status: midiField("status"), atSample };
    case "sysex":
      return {
        type: "sysex",
        data: makeSysexDataProxy(port),
        length: captureTemp<"i32">({ kind: "midiSysexLength", port }, "i32"),
        atSample,
      };
  }
}

/**
 * Inbound sysex `data` proxy: a read-only `TypedArrayFieldRef<'u8'>` whose
 * `.length` is the current drain slot's content-chunk length and which carries
 * a hidden port marker so `buf.copyFrom(data)` knows the source content region.
 * `.at(idx)` reads one byte (rare; the canonical path is `copyFrom` bulk).
 */
function makeSysexDataProxy(port: string): TypedArrayFieldRef<"u8"> {
  const proxy = {
    length: wrapAst<"i32">({ kind: "midiSysexLength", port }),
    at: (_idx: Node<"i32"> | number): Node<"i32"> => {
      throw new Error(
        "unworklet: per-byte .at() on inbound sysex data is not in v1.0.0 — bulk-copy into a buffer.u8 via copyFrom and read through the buffer",
      );
    },
  };
  Object.defineProperty(proxy, MIDI_SYSEX_META, {
    value: { port } satisfies MidiSysexMeta,
    enumerable: false,
  });
  return proxy as unknown as TypedArrayFieldRef<"u8">;
}

function midiFromMain(options: MidiPortOptions): MidiInputHandle {
  const decl: MidiInputDecl = {
    kind: "midiInput",
    name: options.name,
    capacity: options.capacity ?? MIDI_DEFAULT_CAPACITY,
  };
  addDeclaration(decl);
  return {
    name: decl.name,
    onEvent(type, handler) {
      // Handler body is graph-captured (= same path as message onReceive): drains
      // at the block boundary (Q38-b), fields bound to the current slot's bytes.
      const ctx = getCurrentCapture();
      const handlerBody: AstNode[] = [];
      const prev = ctx.currentLoopBody;
      ctx.currentLoopBody = handlerBody;
      try {
        handler(makeMidiEventProxy(type, decl.name) as never);
      } finally {
        ctx.currentLoopBody = prev;
      }
      addStatement({ kind: "midiOnEvent", port: decl.name, eventType: type, body: handlerBody });
    },
  };
}

function midiToMain(options: MidiPortOptions): MidiOutputHandle {
  const decl: MidiOutputDecl = {
    kind: "midiOutput",
    name: options.name,
    capacity: options.capacity ?? MIDI_DEFAULT_CAPACITY,
  };
  addDeclaration(decl);
  return {
    name: decl.name,
    emitIf(cond, event) {
      // A bare inbound `boolean` field used as the emit condition seals it to bool.
      sealInboundFieldBool(cond);
      const condAst: AstNode = isWrappedNode(cond)
        ? unwrapAst(cond)
        : { kind: "literal", type: "i32", value: cond ? 1 : 0 };
      // `atSample` is a common field across every MidiEventEmit variant; default
      // it like event<T> emit (loop counter inside forSample, else block-start 0).
      const atSample: AstNode =
        event.atSample === undefined
          ? getCurrentCapture().currentLoopBody !== null
            ? { kind: "loopCounter" }
            : I32_ZERO
          : liftI32(event.atSample);
      // Map MidiEventGraph → semantic args; emit computes the 8-byte wire slot
      // [status, data1, data2, _pad, atSample] from these per `eventType`.
      const base = { kind: "midiEmitIf" as const, port: decl.name, cond: condAst, atSample };
      switch (event.type) {
        case "noteOn":
        case "noteOff":
          addStatement({
            ...base,
            eventType: event.type,
            channel: liftI32(event.channel),
            arg1: liftI32(event.note),
            arg2: liftI32(event.velocity),
          });
          return;
        case "cc":
          addStatement({
            ...base,
            eventType: "cc",
            channel: liftI32(event.channel),
            arg1: liftI32(event.controller),
            arg2: liftI32(event.value),
          });
          return;
        case "pitchBend":
          addStatement({
            ...base,
            eventType: "pitchBend",
            channel: liftI32(event.channel),
            arg1: liftI32(event.value),
            arg2: I32_ZERO,
          });
          return;
        case "programChange":
          addStatement({
            ...base,
            eventType: "programChange",
            channel: liftI32(event.channel),
            arg1: liftI32(event.program),
            arg2: I32_ZERO,
          });
          return;
        case "channelPressure":
          addStatement({
            ...base,
            eventType: "channelPressure",
            channel: liftI32(event.channel),
            arg1: liftI32(event.pressure),
            arg2: I32_ZERO,
          });
          return;
        case "aftertouch":
          addStatement({
            ...base,
            eventType: "aftertouch",
            channel: liftI32(event.channel),
            arg1: liftI32(event.note),
            arg2: liftI32(event.pressure),
          });
          return;
        case "systemRealtime":
          addStatement({
            ...base,
            eventType: "systemRealtime",
            arg1: liftI32(event.status),
            arg2: I32_ZERO,
          });
          return;
        case "sysex": {
          const dataRef = event.data;
          const length = liftI32((event.length ?? 0) as Node<"i32"> | number);
          const bufMeta = bufferHandleMeta(dataRef);
          const sysexMeta = midiSysexMeta(dataRef);
          if (bufMeta !== undefined) {
            // New content from a worklet buffer.u8 → copy buf[0..length-1] into
            // the port's content region.
            addStatement({
              ...base,
              eventType: "sysex",
              sysexBufferName: bufMeta.decl.name,
              sysexBufferSize: bufMeta.decl.size,
              sysexLength: length,
            });
          } else if (sysexMeta !== undefined) {
            // Thru: copy the inbound port's content chunk into this port's region.
            addStatement({
              ...base,
              eventType: "sysex",
              sysexSourcePort: sysexMeta.port,
              sysexLength: length,
            });
          } else {
            throw new Error(
              "unworklet: midiOutput sysex `data` must be a buffer.u8 (new content) or an inbound sysex `data` proxy (thru)",
            );
          }
          return;
        }
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Unified `event` family (issue #10): direction-aware over the message / event
// / midiInput / midiOutput primitives. `from: 'main'` = worklet receives,
// `to: 'main'` = worklet sends. MIDI is bridged through the main thread (Web
// MIDI lives there), so the same from/to discriminator applies under
// `event.midi`. The internal builders — and their declaration `kind`s / wire —
// are unchanged; only the authoring surface is unified.
// ─────────────────────────────────────────────────────────────────────────

/** `event<T>({ from: 'main' })` — main → worklet delivery (worklet `onReceive`). */
export type EventFromMainOptions = {
  from: "main";
  name: string;
  capacity?: Capacity;
  payloadCapacity?: number;
};

/** `event<T>({ to: 'main' })` — worklet → main delivery (worklet `emitIf`). */
export type EventToMainOptions = {
  to: "main";
  name: string;
  capacity?: Capacity;
  payloadCapacity?: number;
};

/** `event.midi({ from: 'main' })` — inbound MIDI (device → worklet, bridged via main). */
export type MidiFromMainOptions = { from: "main"; name: string; capacity?: Capacity };

/** `event.midi({ to: 'main' })` — outbound MIDI (worklet → device, bridged via main). */
export type MidiToMainOptions = { to: "main"; name: string; capacity?: Capacity };

export interface EventMidiFamily {
  (options: MidiFromMainOptions): MidiInputHandle;
  (options: MidiToMainOptions): MidiOutputHandle;
}

export interface EventFamily {
  <T>(options: EventFromMainOptions): MessageDecl<T>;
  <T>(options: EventToMainOptions): EventDecl<T>;
  readonly midi: EventMidiFamily;
}

function eventImpl<T>(
  options: EventFromMainOptions | EventToMainOptions,
): MessageDecl<T> | EventDecl<T> {
  return "from" in options ? eventFromMain<T>(options) : eventToMain<T>(options);
}

function midiImpl(
  options: MidiFromMainOptions | MidiToMainOptions,
): MidiInputHandle | MidiOutputHandle {
  return "from" in options ? midiFromMain(options) : midiToMain(options);
}

export const event: EventFamily = Object.assign(eventImpl, { midi: midiImpl }) as EventFamily;

// ─────────────────────────────────────────────────────────────────────────
// noiseSource (`01-dsl.md` §2 stateful sources)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Declare a private xorshift32 white-noise generator. Returns a `NoiseSource`
 * handle; each `.next()` call advances the internal PRNG state by one step
 * and returns the next `[-1, 1)` sample.
 *
 * Framework allocates one i32 slot per declaration (see
 * `layout.regions.noiseSources`). Auto seed = declaration order counter
 * (1, 2, 3, …) if `seed` omitted; explicit seed pins the output byte-for-byte
 * across code edits (use for golden snapshots / preset reproducibility).
 * `seed === 0` is silently substituted with a sentinel constant because
 * xorshift32 locks at zero — the user can still specify `seed: 0` without
 * hitting the pathological case.
 *
 * ```ts
 * const nL = noiseSource({ seed: 42 });
 * const nR = noiseSource();  // auto seed = next in order
 * process(() => {
 *   forSample((i) => {
 *     out.left.at(i).write(nL.next().mul(0.3));
 *     out.right.at(i).write(nR.next().mul(0.3));
 *   });
 * });
 * ```
 */
export function noiseSource(options?: NoiseSourceOptions): NoiseSource {
  const ctx = getCurrentCapture();
  const idx = ctx.noiseSourceCount;
  ctx.noiseSourceCount += 1;
  // Auto seed starts at 1 so we never hand out xorshift32's pathological zero.
  const seed = options?.seed ?? idx + 1;
  // The seed exists to pin the stream byte-for-byte, and emission stores it with
  // `seed | 0`. A non-int32 would truncate silently — `0.5`, `NaN` and `Infinity`
  // all land on 0 and then take the zero-seed sentinel, so three distinct seeds
  // would yield one identical stream. Fail loudly instead. (`0` itself is
  // supported; the sentinel substitution for it is documented.)
  if (!Number.isInteger(seed) || seed < -(2 ** 31) || seed > 2 ** 31 - 1) {
    throw new Error(
      `unworklet: noiseSource seed must be an integer in the int32 range ` +
        `[-2147483648, 2147483647], got ${String(seed)}. The seed pins the noise ` +
        `stream byte-for-byte, and a non-integer would truncate to a different one.`,
    );
  }
  const name = `${ctx.namePrefix}__noise_${idx}`;
  addDeclaration({ kind: "noiseSource", name, seed });
  return {
    next(): Node<"f32"> {
      return captureTemp<"f32">({ kind: "noiseSourceNext", type: "f32", name }, "f32");
    },
  };
}
