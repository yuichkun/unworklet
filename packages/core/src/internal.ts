// Internal API used by @unworklet/client and the worklet runtime / offline
// renderer. Not part of the public surface.

export { ProcessorRuntime, Scope, setCurrentRuntime, getCurrentRuntime } from "./runtime.js";

export { Engine, type EngineOptions } from "./engine.js";

export {
  type CaptureBackend,
  getCaptureBackend,
  setCaptureBackend,
} from "./capture-backend.js";

export { attachMethods } from "./methods.js";
export { wrap, unwrap, NodeImpl } from "./node-value.js";

export type {
  StateSlot,
  BufferSlot,
  ParamSlot,
  AudioInputSlot,
  AudioOutputSlot,
  EventSlot,
  MessageSlot,
  MidiInputSlot,
  MidiOutputSlot,
  StateRuntime,
  BufferRuntime,
  ParamRuntime,
  AudioInputRuntime,
  AudioOutputRuntime,
  SubgraphInstance,
} from "./runtime.js";
