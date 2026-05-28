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

import type { AstNode, ParamDecl, StateDecl } from "../compile/ast.ts";
import {
  addDeclaration,
  addStatement,
  getCurrentCapture,
  unwrapAst,
  wrapAst,
} from "../compile/capture.ts";
import type {
  AudioInputHandle,
  AudioOutputHandle,
  Buffer,
  Capacity,
  EventDecl,
  ExposeOptions,
  InputChannelView,
  MessageDecl,
  MidiInputHandle,
  MidiOutputHandle,
  Node,
  OutputChannelView,
  Param,
  ScalarOf,
  ScalarType,
  State,
} from "../types.ts";

const notImplemented = (): never => {
  throw new Error("not implemented");
};

// ─────────────────────────────────────────────────────────────────────────
// Literal lift helpers (= Q36-a)
// ─────────────────────────────────────────────────────────────────────────

function liftOffset(i: Node<"i32"> | number): AstNode {
  if (typeof i === "number") {
    return { kind: "literal", type: "i32", value: i };
  }
  return unwrapAst(i);
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
    // i64 literal store の bigint path は ast.ts の literal `value: number`
    // 制 約 下 で 表 現 不 完 全 = 後 続 sub-phase で literal 型 拡 張 と
    // zip し て fill。 Node<'i64'> 経 由 (= stateLoad 等) は そ の ま ま 通 る。
    throw new Error("i64 literal store not implemented (= 後 続 sub-phase で fill)");
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

// `state` chain (= Q79 chain-order free + Q76 plain factory)。
// plain factory (= `state.f32(0)` 等) は synthetic name (= `__state_<idx>`)
// で declare、 chain `.named('X')` で 後付け / 前付け 両 path で decl.name
// mutate (= param と 同 path)。 `.expose({...})` は sub-phase 7.2 で fill =
// throw stub 維 持。
//
// AST shape の name field は `decl.name` を `.load()` / `.store()` 呼 び 時 点
// で closure capture (= late binding)、 .named() で chain 後 fix が反 映 さ れ る
// 順 序 と zip (= 既 param と 同 規 律: chain は store/load 呼 び 出 し の
// 前 に 完 結 さ せ る = user 責 任)。

const makeStateChain = (pendingName: string | undefined): StateChain => ({
  f32: (initial) => makeStateDecl("f32", initial, pendingName),
  f64: (initial) => makeStateDecl("f64", initial, pendingName),
  i32: (initial) => makeStateDecl("i32", initial, pendingName),
  i64: (initial) => makeStateDecl("i64", initial, pendingName),
  bool: (initial) => makeStateDecl("bool", initial, pendingName),
  named: (name) => makeStateChain(name),
  expose: () => notImplemented(),
});

/**
 * state slot の name uniqueness check (= `01-dsl.md` §3.1 + Q5-b)。
 *
 * declare 時 (= `state.f32(0)` / `state.named('X').f32(0)`) と .named()
 * 後 付 け mutate 時 の 両 path で 走 る。 `excludeDecl` を 渡 す と 自 decl
 * を 除 外 し て check (= .named() で 自 分 を 上 書 き す る path で 自 collide
 * を 誤 検 出 し な い)。 同 kind 内 で name は unique = type が違 っ て も collide
 * (= `state.named('x').f32(0)` + `state.named('x').i32(0)` も graph-capture-time
 * error)。
 */
function checkStateName(name: string, excludeDecl: StateDecl | null = null): void {
  const ctx = getCurrentCapture();
  if (ctx.declarations.some((d) => d.kind === "state" && d.name === name && d !== excludeDecl)) {
    throw new Error(
      `unworklet: duplicate state declaration name "${name}" — state names must be unique within a processor`,
    );
  }
}

function makeStateDecl<T extends ScalarType>(
  type: T,
  initial: ScalarOf<T>,
  pendingName: string | undefined,
): State<T> {
  const ctx = getCurrentCapture();
  const synthIdx = ctx.declarations.filter((d) => d.kind === "state").length;
  const name = pendingName ?? `__state_${synthIdx}`;
  checkStateName(name);
  const decl: StateDecl = {
    kind: "state",
    name,
    type,
    initial: initial as number | bigint | boolean,
    userNamed: pendingName !== undefined,
  };
  addDeclaration(decl);
  return makeStateHandle<T>(decl);
}

function makeStateHandle<T extends ScalarType>(decl: StateDecl): State<T> {
  const handle = {
    load: () =>
      wrapAst<T>({
        kind: "stateLoad",
        type: decl.type,
        name: decl.name,
      }),
    store: (v: Node<T> | ScalarOf<T>) => {
      addStatement({
        kind: "stateStore",
        type: decl.type,
        name: decl.name,
        value: liftStoreValue<T>(decl.type as T, v),
      });
    },
    named: (name: string) => {
      checkStateName(name, decl);
      decl.name = name;
      decl.userNamed = true;
      return handle;
    },
    expose: () => notImplemented(),
  } as unknown as State<T>;
  return handle;
}

export const state: StateChain = makeStateChain(undefined);

// ─────────────────────────────────────────────────────────────────────────
// `buffer` — fixed-size arrays (`01-dsl.md` §3.2)
// ─────────────────────────────────────────────────────────────────────────

type BufferFactory<T extends ScalarType | "u8"> = (options: { size: number }) => Buffer<T>;

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

export const buffer: BufferChain = {
  f32: () => notImplemented(),
  f64: () => notImplemented(),
  i32: () => notImplemented(),
  i64: () => notImplemented(),
  bool: () => notImplemented(),
  u8: () => notImplemented(),
  named: () => notImplemented(),
  expose: () => notImplemented(),
};

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
        offset: liftOffset(i),
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
        offset: liftOffset(i),
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
          offset: liftOffset(i),
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

export function event<T>(_options: EventOptions): EventDecl<T> {
  return notImplemented();
}

export function message<T>(_options: MessageOptions): MessageDecl<T> {
  return notImplemented();
}

// ─────────────────────────────────────────────────────────────────────────
// MIDI declarations (`11-midi.md` §1)
// ─────────────────────────────────────────────────────────────────────────

export type MidiPortOptions = {
  name: string;
  capacity?: Capacity;
};

export function midiInput(_options: MidiPortOptions): MidiInputHandle {
  return notImplemented();
}

export function midiOutput(_options: MidiPortOptions): MidiOutputHandle {
  return notImplemented();
}
