/**
 * `@unworklet/core` — public surface.
 *
 * Stub stage: type surface and build-time constants are declared here;
 * runtime behavior is filled in incrementally across subsequent commits.
 */

// Build-time constants.
export {
  CAPACITY_16,
  CAPACITY_32,
  CAPACITY_64,
  CAPACITY_128,
  CAPACITY_256,
  CAPACITY_512,
  CAPACITY_1024,
  CAPACITY_2048,
  CAPACITY_4096,
  CAPACITY_8192,
  CAPACITY_16384,
  SAMPLES_PER_BLOCK,
} from "./dsl/constants.ts";

// Scalar constructors.
export { bool, f32, f64, i32, i64, num } from "./dsl/constructors.ts";

// DSL primitive operators (Node<T> method form extended via declaration merging).
export {
  abs,
  add,
  ceil,
  clamp,
  cos,
  div,
  eq,
  exp,
  floor,
  frac,
  gt,
  gte,
  log,
  lt,
  lte,
  max,
  min,
  mod,
  mul,
  neg,
  select,
  sin,
  sqrt,
  sub,
  tan,
  tanh,
} from "./dsl/primitives.ts";

// Declaration helpers.
export {
  audioInput,
  audioOutput,
  buffer,
  event,
  message,
  midiInput,
  midiOutput,
  param,
  state,
} from "./dsl/declarations.ts";

export type {
  BufferChain,
  EventOptions,
  MessageOptions,
  MidiPortOptions,
  ParamChain,
  ParamOptions,
  StateChain,
} from "./dsl/declarations.ts";

// Loop primitive.
export { forSample } from "./dsl/loop.ts";
export type { EveryNSamples, ForSampleCallback, ForSampleFn } from "./dsl/loop.ts";

// Processor / subgraph constructors.
export { createSubgraph, defineProcessor, defineSubgraph } from "./processor.ts";
export type { CreateSubgraphOptions, SubgraphDecl } from "./processor.ts";

// Compile invocation.
export { compile } from "./compile/index.ts";

// Worklet meta extraction (= used by vite-plugin to inline runtime-only
// metadata into the AudioWorkletGlobalScope entry, avoiding any
// re-evaluation of the authoring source in the worklet realm)。
export { extractWorkletMeta } from "./worklet.ts";
export type { WorkletMeta } from "./worklet.ts";

// MIDI wire codec (= 8-byte fixed slot ↔ MidiEvent、 `11-midi.md` §4.1)。
// offline renderer / worklet template / main client が 共 有 す る wire 単 一 source。
export { midiEventToWire, wireToMidiEvent } from "./midiWire.ts";
export type { MidiWireBytes } from "./midiWire.ts";

// Snapshot blob codec + migration engine (= `01-dsl.md` §8)。 offline renderer /
// main client が blob を build / read / migrate する 共 有 infrastructure。
export {
  decodeScalar,
  decodeSnapshot,
  decodeTypedArray,
  encodeScalar,
  encodeSnapshot,
  inspectSnapshot,
  runMigrations,
  SNAPSHOT_VERSION,
} from "./snapshot.ts";
export type {
  DecodedSnapshot,
  MigrationOutcome,
  SnapshotSlot,
  SnapshotSlotKind,
} from "./snapshot.ts";

// Main-thread client surface.
export { createNode, inspect } from "./client.ts";

// Dynamic processor swap primitive.
export { replaceProcessor } from "./replaceProcessor.ts";

// Public types.
export type {
  AudioInputHandle,
  AudioOutputHandle,
  AudioPortDescriptor,
  Buffer,
  BufferElementType,
  BufferValueProxy,
  Capacity,
  ChannelIndex,
  CompiledProcessor,
  CompileDriver,
  CompileInstance,
  CompileInstanceDeclaration,
  CompileOptions,
  CompileResult,
  CreateNodeOptions,
  DiagnosticsJson,
  EmitPayload,
  EventDecl,
  EventSubscriber,
  ExposeOptions,
  GraphJson,
  InputChannelView,
  InspectionResult,
  MemoryJson,
  MessageDecl,
  MessageSender,
  MidiEvent,
  MidiEventGraph,
  MidiEventGraphOf,
  MidiEventType,
  MidiInputHandle,
  MidiOutputHandle,
  MidiPortSurface,
  Migration,
  MigrationHelpers,
  Node,
  NodeErrorEvent,
  OutputChannelSample,
  OutputChannelView,
  Param,
  ProcessorBody,
  ProcessorContext,
  ProcessorGraph,
  ProcessorOptions,
  PublishOptions,
  PublishSlotDescriptor,
  ReplaceResult,
  RestoreFailure,
  RestoreOk,
  RestoreResult,
  ScalarOf,
  ScalarType,
  SlotInspection,
  SnapshotPolicy,
  State,
  StateValueProxy,
  TransportMode,
  TypedArrayFieldRef,
  TypedArrayOf,
  UnworkletNode,
  WorkletNamespace,
} from "./types.ts";
