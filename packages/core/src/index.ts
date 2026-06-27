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
export { bool, f32, f64, i32, i64 } from "./dsl/constructors.ts";

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
  not,
  select,
  sin,
  sqrt,
  sub,
  tan,
  tanh,
} from "./dsl/primitives.ts";

// Composition helper (`pipe(x, ...fns)` + `Node<T>.pipe(fn)`).
export { pipe } from "./dsl/pipe.ts";

// Declaration helpers.
export { audioInput, audioOutput, event, param, state } from "./dsl/declarations.ts";

export type {
  BufferChain,
  EventFamily,
  EventFromMainOptions,
  EventMidiFamily,
  EventToMainOptions,
  MidiFromMainOptions,
  MidiToMainOptions,
  ParamChain,
  ParamOptions,
  StateChain,
} from "./dsl/declarations.ts";

// Loop primitive.
export { forSample } from "./dsl/loop.ts";
export type { EveryNSamples, ForSampleCallback, ForSampleFn } from "./dsl/loop.ts";

// Processor / subgraph constructors.
export { instantiate, defineProcessor, defineSubgraph } from "./processor.ts";
export type { CreateSubgraphOptions, SubgraphDecl } from "./processor.ts";

// Compile invocation.
export { compile } from "./compile/index.ts";

// Worklet meta extraction (= used by unplugin to inline runtime-only
// metadata into the AudioWorkletGlobalScope entry, avoiding any
// re-evaluation of the authoring source in the worklet realm).
export { extractWorkletMeta } from "./worklet.ts";
export type { WorkletMeta } from "./worklet.ts";

// The single worklet-module source emitter, shared by the build-time `?worklet`
// chunk (unplugin, `import` runtime) and the in-browser runtime-compile path
// (`@unworklet/lang/browser`, `inline` runtime).
export { emitWorkletModuleSource, serializeMetaToJs } from "./worklet-module.ts";
export type { WorkletRuntimeSource, EmitWorkletModuleOptions } from "./worklet-module.ts";

// MIDI wire codec (= 8-byte fixed slot ↔ MidiEvent, `11-midi.md` §4.1).
// The single wire-format source shared by the offline renderer, worklet template, and main client.
export { midiEventToWire, wireToMidiEvent } from "./midiWire.ts";
export type { MidiWireBytes } from "./midiWire.ts";

// Shared ring-index helper (= the single source of truth for mapping a ring
// head/tail counter to a slot index, correct across the i32 2^31 wrap). Used by
// the worklet SAB copy, the main-thread drain, and the offline renderer.
export { ringSlotIndex } from "./ringIndex.ts";

// Snapshot blob codec + migration engine (= `01-dsl.md` §8). Shared
// infrastructure used by the offline renderer and main client to build, read, and migrate blobs.
export { decodeScalar, decodeTypedArray, encodeScalar } from "./snapshot.ts";
export type { SnapshotSlot, SnapshotSlotKind } from "./snapshot.ts";
export {
  decodeSnapshot,
  encodeSnapshot,
  inspectSnapshot,
  runMigrations,
  SNAPSHOT_VERSION,
} from "./snapshotBlob.ts";
export type { DecodedSnapshot, MigrationOutcome } from "./snapshotBlob.ts";

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
  EventRingSlotDescriptor,
  EventSurface,
  ExposeOptions,
  GraphJson,
  InputChannelView,
  InspectionResult,
  MemoryJson,
  MessageDecl,
  MessageGraphPayload,
  MessageRingSlotDescriptor,
  MidiEvent,
  MidiEventEmit,
  MidiEventEmitOf,
  MidiEventGraph,
  MidiEventGraphOf,
  MidiEventType,
  MidiInputHandle,
  MidiOutputHandle,
  MidiPortSurface,
  MidiRingSlotDescriptor,
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
