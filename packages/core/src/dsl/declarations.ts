/**
 * Declaration helpers (`01-dsl.md` §1 / §3 / §4 + `11-midi.md` §1).
 *
 * Declaration scope only: each helper registers a slot in the graph and
 * a region in WASM linear memory. state / buffer / event / message /
 * MIDI = Phase 3 throw stub (= 後 続 phase fill)。
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
  OutputChannelView,
  Param,
  ScalarOf,
  ScalarType,
  State,
  TypedArrayFieldRef,
} from "../types.ts";

const notImplemented = (): never => {
  throw new Error("not implemented");
};

/**
 * typed-array payload proxy node に隠し持たせる「どの message のどの field か」
 * の meta。`buf.copyFrom(payloadField)` が src からこれを読んで bufferCopyFrom AST
 * を組む (= 公開型 `TypedArrayFieldRef` は length/at だけ、内部は symbol で carry)。
 */
const PAYLOAD_FIELD_META = Symbol("unworklet.payloadFieldMeta");

type PayloadFieldMeta = { decl: MessageDeclAst; field: string };

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
 * buffer handle に隠し持たせる identity (= name + element type)。`event.emitIf` が
 * typed-array field の値として渡された buffer を検出 (= §4.3 worklet→main の emit
 * 側) するための marker。公開型 `Buffer<T>` には現れない内部 symbol。
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
 * `state.<type>.store(v)` の value 引 数 を AST に lift (= Q33 literal lift
 * + Node<T> unwrap)。 i64 は bigint 必 須、 bool は boolean → i32 0/1 に
 * 内 部 表 現 変 換 (= Q42 + emit.ts bool case と zip)。 既 ast.ts の
 * literal kind は `value: number` 制 約 = i64 literal の bigint store は
 * 後 続 sub-phase で literal 型 拡 張 と zip し て fill。
 */
function liftStoreValue<T extends ScalarType>(type: T, v: Node<T> | ScalarOf<T>): AstNode {
  if (typeof v === "number") {
    return { kind: "literal", type, value: v };
  }
  if (typeof v === "boolean") {
    // bool は 内 部 i32 表 現 (= store 経 路 で i32.store)。
    return { kind: "literal", type: "i32", value: v ? 1 : 0 };
  }
  if (typeof v === "bigint") {
    // i64 literal store: bigint を そ の ま ま literal node に 担 ぐ (= emit が
    // `i64.const` へ 32bit word 分 割)。 Node<'i64'> 経 由 (= stateLoad 等) も 同 path。
    return { kind: "literal", type: "i64", value: v };
  }
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
// type 制 限)。 chain `.named('X')` / `.expose({ name, snapshot, publish })`
// を pendingExpose に accumulate (= field after-wins merge)、 type method
// (= `.f32(0)` 等) で makeStateDecl が 走 り decl を 作 成。 handle 後 付 け
// `.named` / `.expose` も 同 merge logic で decl mutate。
//
// AST shape の name field は `decl.name` を `.load()` / `.store()` 呼 び 時 点
// で closure capture (= late binding)、 chain 後 fix が反 映 さ れ る 順 序 と zip
// (= 既 param と 同 規 律: chain は store/load 呼 び 出 し の 前 に 完 結 さ せ る
// = user 責 任)。
//
// validate timing は eager (= chain ご と) で 走 る = 早 期 error で chain
// 途 中 で 即 reject。

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
 * state slot の name uniqueness check (= `01-dsl.md` §3.1 + Q5-b)。
 *
 * declare 時 (= `state.f32(0)` / `state.named('X').f32(0)`) と .named() /
 * .expose() 後 付 け mutate 時 の 両 path で 走 る。 `excludeDecl` を 渡 す と
 * 自 decl を 除 外 し て check (= .named() で 自 分 を 上 書 き す る path で
 * 自 collide を 誤 検 出 し な い)。 同 kind 内 で name は unique = type が違 っ
 * て も collide。
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
 * state slot の publish / snapshot 整 合 性 check (= Q42 + `01-dsl.md` §3.1)。
 * - publish + 不 正 type (f64 / i64) → throw
 * - publish + rateFps <= 0 (NaN 含 む) → throw
 * - publish + userNamed = false (= synthetic name) → throw
 * - snapshot 'persistent' + userNamed = false → throw
 *
 * eager (= chain method ご と) で 走 る = 不 正 chain を 早 期 reject。
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
  // user name は subgraph instance prefix を前置 (= §5.6)。 auto name は global
  // synthIdx で既に一意 = prefix 不要。
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
    load: () =>
      // Eager temp-local capture freezes the slot value at this lexical point
      // (= `03-compiler.md` §2.7, issue #8) — a later `store` cannot change it.
      captureTemp<T>(
        {
          kind: "stateLoad",
          type: decl.type,
          name: decl.name,
        },
        decl.type,
      ),
    store: (v: Node<T> | ScalarOf<T>) => {
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
      // user name は subgraph instance prefix を前置 (= §5.6、buffer / .named と同軸)。
      const exposeName =
        options.name !== undefined ? getCurrentCapture().namePrefix + options.name : undefined;
      if (exposeName !== undefined && exposeName !== decl.name) {
        checkStateName(exposeName, decl);
        decl.name = exposeName;
        decl.userNamed = true;
      } else if (exposeName !== undefined) {
        // 同 name 再 set = userNamed flag を true へ promote (= 後 付 け .expose
        // で 自 decl と 同 name 渡 す path = user 明 示 と み な す)
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

export const state: StateChain = makeStateChain(EMPTY_EXPOSE);

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
  if (typeof v === "number") {
    return { kind: "literal", type: st, value: st === "i32" ? v | 0 : v };
  }
  return unwrapAst(v);
}

/**
 * buffer slot の name uniqueness check (= `01-dsl.md` §3.2、 state と 同 規 約)。
 * 同 kind 内 で unique (= type が違っても collide)。 `excludeDecl` で 後 付 け
 * `.named` 時 の 自 collide 誤 検 出 を 回 避。
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
 * buffer slot の publish / snapshot 整 合 性 check (= `01-dsl.md` §3.2)。 state と
 * 同 軸 だ が publish の type 制 限 は ナ シ (= 全 element 型 で publish 可、 Q27-a/e)。
 * persistent snapshot / publish は main-side identity 必 須 = userNamed 必 須。
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
  // user name は subgraph instance prefix を前置 (= §5.6、state と同軸)。 auto name は
  // global synthIdx で既に一意 = prefix 不要。 複数 instance で named buffer が衝突しない。
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
  // literal index / offset を graph-capture 時に range check (= §3.2: literal range
  // constraints は capture で reject)。 dynamic Node<'i32'> は caller 責任 (= no check)。
  // lanes は SIMD load/store が触る連続要素数 (= read/write は 1、loadVec/storeVec は 4)。
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
      // 補間は floor(pos) と floor(pos)+1 の 2-tap を読むので literal pos は [0, size-1)。
      if (typeof pos === "number" && (!(pos >= 0) || pos >= decl.size - 1)) {
        throw new Error(
          `unworklet: buffer "${decl.name}" readInterpolated(${pos}) pos is out of range [0, ${decl.size - 1}) (= 2-tap 補間は floor(pos)+1 まで読む; literal pos は capture で range-check)`,
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
      const meta = (src as unknown as Record<symbol, PayloadFieldMeta | undefined>)[
        PAYLOAD_FIELD_META
      ];
      if (meta === undefined) {
        throw new Error(
          "unworklet: buffer.copyFrom(src) requires a typed-array message payload field",
        );
      }
      // field を dest buffer の element type で typed-array seal (= TypedArrayFieldRef<T>
      // の T が buffer 型と一致する型制約があるので payloadContent + 8-byte slot 確保)。
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
    // SIMD buffer I/O (= §7、型は @unworklet/core/simd の declaration merge で f32 限定)。
    // offset は element 単位 = emit 側で × 4 byte。 4 lane を v128 で load/store。
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
  // event.emitIf が typed-array field の値として渡された buffer を識別する marker
  // (= §4.3 worklet→main、 decl 参 照 で late-bind name も追従)。
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

export const buffer: BufferChain = makeBufferChain(EMPTY_EXPOSE);

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

// `param` chain (= Q76 named-required + Q79 chain-order free)。
// `.f32(opts)` 時 に declaration を graph に append し、 chain の `.named()` は
// 後 付 け / 前 付 け 両 方 で 同 declaration を 指 す (= after-wins、 mutate)。
// `param.at(i)` は decl.name を late-binding で 読 む = `.named` 重 複 後 でも
// 最 新 name を 反 映。 `.expose({...})` は Phase 7 で fill = throw stub 維 持。

const makeParamChain = (pendingName: string | undefined): ParamChain => ({
  f32: (options) => {
    const decl: ParamDecl = {
      kind: "param",
      name: pendingName ?? "",
      type: "f32",
      default: options.default,
      min: options.min,
      max: options.max,
      automationRate: options.automationRate,
    };
    addDeclaration(decl);
    return makeParam(decl);
  },
  named: (name) => makeParamChain(name),
  expose: () => notImplemented(),
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
    expose: () => notImplemented(),
  } as unknown as Param;
  return handle;
}

export const param: ParamChain = makeParamChain(undefined);

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
 * `event<T>` declaration の name uniqueness check (= `01-dsl.md` §4.1)。
 *
 * 同 kind 内 で name unique = state と zip pattern (= cross-kind は 物 理 layout
 * region 別 で 衝 突 ナ シ、 同 kind 内 だ け check)。 `node.events.<name>` の
 * key collision を 防 ぐ 第 一 目 的。
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
 * `event<T>` 2 番 目 以 降 の emit site で 既 seal 済 field と name + wire 型
 * 整 合 を check (= `01-dsl.md` §4.1)。 不 一 致 = graph-capture-time error
 * (= stable ID `event-field-type-mismatch`)。 1 番 目 emit site で の seal は
 * emitIf 内 で 直 接 `decl.fields.push` で 行 う。
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

// typed-array (variable-length) field 用の checkSealedEventField (= Q71)。後続 emit site が
// first site で seal されていない typed-array field を足す / element 型を変える のを弾く
// (= scalar field と同じ field-set 一致契約を typed-array field にも適用)。
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
 * `eventDecl.emitIf` 1 emit site で 1 field の 値 を AST 化 + wire 型 推 論。
 *
 * - `Node<T>` → unwrapAst + inferAstType で wireType 取 得
 * - `boolean` → literal { type: 'bool', value: 0/1 path = 内 部 i32 表 現、 wireType = 'bool' }
 * - `number` → 既 sealed wire 型 が あ れ ば そ れ に lift (= 後 続 emit site の literal は 1 番 目 の wire 型 に zip)、 未 sealed = default f32 lift (= Q33 規 範)
 *
 * Q71 docs 規 範: 1 番 目 emit site で wire 型 確 定。 literal だ け の 1 番 目
 * emit = default f32 (= Q33 numeric literal → Node<'f32'>)。
 */
function liftEmitFieldValue(
  decl: EventDeclAst,
  fieldName: string,
  raw: unknown,
): { ast: AstNode; wireType: ScalarType } {
  if (isWrappedNode(raw)) {
    const ast = unwrapAst(raw);
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

export function event<T>(options: EventOptions): EventDecl<T> {
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
      const condAst: AstNode = isWrappedNode(cond)
        ? unwrapAst(cond)
        : { kind: "literal", type: "i32", value: cond ? 1 : 0 };
      // atSample default lift (= B 案):
      // - forSample callback 内 (= currentLoopBody !== null) → loopCounter Node
      // - per-block top level (= currentLoopBody === null) → literal 0
      // user override は そ の ま ま 通 過 (= Node<'i32'> | number)。 不 正 型 (= string 等)
      // = throw。 sub-phase 7.7 / 9 で handler context default を 追 加 path。
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
      // typed-array field (§4.3 worklet→main) = 値が buffer handle のもの (§5.1: 高々 1 個)。
      // 隣 接 の `length` field は framework-injected = その typed-array field の copy 長 =
      // wire field 扱 い し ない (= consume)。
      const taFieldName = allKeys.find((k) => bufferHandleMeta(payload[k]) !== undefined);
      const scalarKeys = allKeys.filter(
        (k) => k !== taFieldName && !(taFieldName !== undefined && k === "length"),
      );
      const emitFields: EventEmitField[] = [];
      const isFirstEmit = decl.fields.length === 0;
      for (const fieldName of scalarKeys) {
        const { ast, wireType } = liftEmitFieldValue(decl, fieldName, payload[fieldName]);
        if (isFirstEmit) {
          // 1 番 目 emit = full field set を seal (= 同 emit 内 で 重 複 field を
          // 受 け 取 ら な い path、 Object.keys は unique = OK)。
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
          wireType: "i32", // dummy (= slot は [payloadLen, payloadOffset]、 payloadElementType で 分 岐)
          value: { kind: "literal", type: "i32", value: 0 }, // placeholder (= 未 使 用)
          payloadElementType: elementType,
          bufferName: bufMeta.decl.name,
          bufferSize: bufMeta.decl.size, // emit が copy byte 数を buffer 境界に clamp する
          length: lengthAst,
        });
      }
      if (!isFirstEmit && emitFields.length !== decl.fields.length) {
        const missing = decl.fields.filter((f) => !emitFields.some((e) => e.name === f.name));
        /* v8 ignore next 8 — extra field path は checkSealedEventField で 既 throw、
           こ こ の missing.length > 0 path だ け が field-count 不 一 致 か つ extra ナ シ
           = 「subset emit」 path で hit、 既 「Q71: field set 縮 小」 test で hit 済 */
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
 * `message<T>` declaration の name uniqueness check (= `01-dsl.md` §4.2)。
 * 同 kind 内 で name unique = state / event と zip pattern。
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
 * `onReceive` handler の payload proxy (= Q46 uniform lift)。
 *
 * user が `({ slot, gain }) => ...` で destructure す る = proxy.get(prop) で
 * 各 field name を 拾 い + `Node<'i32'>` (= field type erasure path = 全 number
 * field 統 一 lift、 boolean / typed-array は 後 続 sub-phase で fill) を 返 す。
 * 同 時 に decl.fields に push (= 1 番 目 onReceive で seal、 後 続 onReceive で
 * 同 field 名 を 何 度 access し て も 同 wire 型 で 通 す)。
 */
/**
 * `onReceive` handler が destructure で 触 る field を hybrid handle と し て 返 す。
 * scalar 利 用 (= `state.store(field)` 等) は Node<'i32'> と し て 振 る 舞 い、
 * typed-array 利 用 (= `field.at(i)` / `field.length`) は `01-dsl.md` §4.3 の
 * proxy を 露 出。 field の wire 種 別 は 「ど ち ら の interface を 使 っ た か」 で
 * seal す る (= TS の 2-view で user code は 一 貫 し て 片 方 だ け を 使 う)。
 * typed-array element 型 は v1.0.0-a で f32 固 定 (= Float32Array audio payload、
 * Uint8Array/u8 = sysex は MIDI scope)。
 */
function makeMessagePayloadProxy(decl: MessageDeclAst): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get(_target, prop): unknown {
        /* v8 ignore next 2 — defensive symbol access guard (= destructure path
           は string key の み hit) */
        if (typeof prop !== "string") return undefined;
        const fieldName = prop;
        // 既 seal 済 と 整 合 = 何 度 access し て も 同 field、 未 seal = i32 で push
        if (!decl.fields.some((f) => f.name === fieldName)) {
          decl.fields.push({ name: fieldName, wireType: "i32" });
        }
        const sealTypedArray = (): void => {
          const field = decl.fields.find((f) => f.name === fieldName);
          if (field !== undefined) field.payloadElementType = "f32";
        };
        // scalar view = messageFieldRead i32 を astPayload に 持 つ Node。
        const node = wrapAst<"i32">({
          kind: "messageFieldRead",
          name: decl.name,
          field: fieldName,
          wireType: "i32",
        }) as unknown as Record<string, unknown>;
        // typed-array view (= §4.3 proxy)。 access し た 時 点 で field を typed-array seal。
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
        // `buf.copyFrom(field)` 用 = field の所属 message + field 名を隠し carry
        // (= buffer handle がここから bufferCopyFrom AST を組む、seal も向こうで行う)。
        Object.defineProperty(node, PAYLOAD_FIELD_META, {
          value: { decl, field: fieldName } satisfies PayloadFieldMeta,
          enumerable: false,
        });
        return node;
      },
    },
  );
}

export function message<T>(options: MessageOptions): MessageDecl<T> {
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
      // handler body を build-time eval し て AST 化、 既 forSample path と zip
      // (= currentLoopBody を sub-list に 切 替 え て collect、 戻 し て push)。
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

export function midiInput(options: MidiPortOptions): MidiInputHandle {
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

export function midiOutput(options: MidiPortOptions): MidiOutputHandle {
  const decl: MidiOutputDecl = {
    kind: "midiOutput",
    name: options.name,
    capacity: options.capacity ?? MIDI_DEFAULT_CAPACITY,
  };
  addDeclaration(decl);
  return {
    name: decl.name,
    emitIf(cond, event) {
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
