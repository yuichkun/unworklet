/**
 * Declaration helpers (`01-dsl.md` §1 / §3 / §4 + `11-midi.md` §1).
 *
 * Declaration scope only: each helper registers a slot in the graph
 * and a region in WASM linear memory. Stub stage = chain objects /
 * factory functions return non-functional handles whose method calls
 * throw `not implemented`.
 *
 * Named-factory chain (= Q79): `.named('X')` quick form / `.expose({ name, ... })`
 * full form are exposed both **before** the type method (`state.named('X').f32(0)`)
 * and **after** (`state.f32(0).named('X')`). Field merge = after-wins.
 */

import type {
  AudioInputHandle,
  AudioOutputHandle,
  Buffer,
  Capacity,
  EventDecl,
  ExposeOptions,
  MessageDecl,
  MidiInputHandle,
  MidiOutputHandle,
  Param,
  ScalarOf,
  ScalarType,
  State,
} from "../types.ts";

const notImplemented = (): never => {
  throw new Error("not implemented");
};

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

export const param: ParamChain = {
  f32: () => notImplemented(),
  named: () => notImplemented(),
  expose: () => notImplemented(),
};

// ─────────────────────────────────────────────────────────────────────────
// Audio I/O declarations (`01-dsl.md` §1.1)
// ─────────────────────────────────────────────────────────────────────────

export function audioInput<C extends number>(_options: {
  channels: C;
  name: string;
}): AudioInputHandle<C> {
  return notImplemented();
}

export function audioOutput<C extends number>(_options: {
  channels: C;
  name: string;
}): AudioOutputHandle<C> {
  return notImplemented();
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
