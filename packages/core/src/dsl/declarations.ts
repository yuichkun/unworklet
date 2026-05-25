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

import type { AstNode, ParamDecl } from "../compile/ast.ts";
import { addDeclaration, addStatement, unwrapAst, wrapAst } from "../compile/capture.ts";
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

export const state: StateChain = {
  f32: () => notImplemented(),
  f64: () => notImplemented(),
  i32: () => notImplemented(),
  i64: () => notImplemented(),
  bool: () => notImplemented(),
  named: () => notImplemented(),
  expose: () => notImplemented(),
};

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
