import type {
  ScalarType,
  ProcessorOptions,
  ProcessorBody,
  CompiledProcessor,
  MidiEvent,
} from "./types.js";

type SnapshotPolicy =
  | "persistent"
  | "transient"
  | { [profile: string]: "persistent" | "transient" };

export type StateSlot = {
  kind: "state";
  type: ScalarType;
  name?: string;
  initial: number | boolean;
  snapshot: SnapshotPolicy;
  publish?: { rateFps: number };
  path: string;
};

export type BufferSlot = {
  kind: "buffer";
  type: ScalarType;
  name: string;
  size: number;
  snapshot: SnapshotPolicy;
  publish?: { rateFps: number };
  path: string;
};

export type ParamSlot = {
  kind: "param";
  name: string;
  default: number;
  min: number;
  max: number;
  automationRate: "a-rate" | "k-rate";
  unit?: string;
  snapshot: SnapshotPolicy;
};

export type AudioInputSlot = {
  kind: "audioInput";
  name: string;
  channels: number;
};

export type AudioOutputSlot = {
  kind: "audioOutput";
  name: string;
  channels: number;
};

export type EventSlot = {
  kind: "event";
  name: string;
  capacity: number;
};

export type MessageSlot = {
  kind: "message";
  name: string;
  capacity: number;
};

export type MidiInputSlot = {
  kind: "midiInput";
  name: string;
  capacity: number;
};

export type MidiOutputSlot = {
  kind: "midiOutput";
  name: string;
  capacity: number;
};

export type StateRuntime = {
  slot: StateSlot;
  storage: Float32Array | Float64Array | Int32Array | BigInt64Array | { value: boolean };
  read(): number | boolean;
  write(v: number | boolean): void;
};

export type BufferRuntime = {
  slot: BufferSlot;
  storage: Float32Array | Int32Array | Float64Array;
};

export type ParamRuntime = {
  slot: ParamSlot;
  values: Float32Array;
  currentValue: number;
};

export type AudioInputRuntime = {
  slot: AudioInputSlot;
  channels: Float32Array[];
};

export type AudioOutputRuntime = {
  slot: AudioOutputSlot;
  channels: Float32Array[];
};

export type EventRuntime = {
  slot: EventSlot;
};

export type MessageRuntime = {
  slot: MessageSlot;
};

export type MidiInputRuntime = {
  slot: MidiInputSlot;
};

export type MidiOutputRuntime = {
  slot: MidiOutputSlot;
};

// A "scope" represents either a root processor or a subgraph instance.
// Each scope owns its state and buffer slots, plus subgraph instance pools.
export class Scope {
  states: Array<StateRuntime> = [];
  buffers: Array<BufferRuntime> = [];

  // For subgraph re-invocation: counters reset on each scope entry, allowing
  // repeated body execution to find the same slots in order.
  declCursor = { state: 0, buffer: 0 };

  // For storing subgraph instance pools indexed by subgraph id.
  subgraphInstances: Map<number, SubgraphInstance[]> = new Map();
  subgraphCursors: Map<number, number> = new Map();

  // Path prefix for snapshot identity (e.g. 'lpfL/' or '').
  pathPrefix: string;

  // Whether this scope has been "fully declared" yet (first body execution complete).
  fullyDeclared = false;

  constructor(pathPrefix: string = "") {
    this.pathPrefix = pathPrefix;
  }

  resetDeclCursor(): void {
    this.declCursor.state = 0;
    this.declCursor.buffer = 0;
  }

  resetSubgraphCursors(): void {
    for (const [k] of this.subgraphCursors) this.subgraphCursors.set(k, 0);
  }
}

export type SubgraphInstance = {
  scope: Scope;
  // The cached "process function" returned from the subgraph body if it returned { process }.
  processFn?: () => any;
  // Cached args reference is not needed — we re-run with fresh args each call.
};

export class ProcessorRuntime {
  audioInputs: Array<{ slot: AudioInputSlot; runtime: AudioInputRuntime }> = [];
  audioOutputs: Array<{ slot: AudioOutputSlot; runtime: AudioOutputRuntime }> = [];
  params: Array<{ slot: ParamSlot; runtime: ParamRuntime }> = [];
  events: Array<{ slot: EventSlot; runtime: EventRuntime }> = [];
  messages: Array<{ slot: MessageSlot; runtime: MessageRuntime }> = [];
  midiInputs: Array<{ slot: MidiInputSlot; runtime: MidiInputRuntime }> = [];
  midiOutputs: Array<{ slot: MidiOutputSlot; runtime: MidiOutputRuntime }> = [];

  rootScope: Scope = new Scope("");
  allScopes: Scope[] = [this.rootScope];
  scopeStack: Scope[] = [this.rootScope];

  iStack: number[] = [];

  inProcess = false;
  inSetup = true;

  currentBlockSize = 128;
  sampleRate = 48000;

  // For everyNSamples: absolute sample position at the start of current block.
  _absoluteSamplePos = 0;

  midiHandlers: Map<string, Map<string, Array<(e: any) => void>>> = new Map();
  messageHandlers: Map<string, Array<(payload: any) => void>> = new Map();
  pendingMessages: Array<{ name: string; payload: any }> = [];
  pendingMessageOverflow: Map<string, number> = new Map();
  pendingMidiEvents: Map<string, MidiEvent[]> = new Map();

  publishObservers: Map<string, ((value: any) => void)[]> = new Map();
  publishCounters: Map<string, number> = new Map();
  publishLastValues: Map<string, any> = new Map();

  outboundEvents: Map<string, Array<{ atSample: number; payload: any }>> = new Map();
  outboundEventOverflow: Map<string, number> = new Map();
  outboundMidi: Array<{ event: MidiEvent }> = [];
  outboundMidiOverflow = 0;

  schemaHash: string = "";
  options?: ProcessorOptions;

  // The processFn returned by the user's processor body
  processFn?: () => void;

  // Set per-block: true once messages/MIDI have been drained (right before
  // first forSample iteration). If still false at end of process(), drain at end.
  _messagesDrained = false;
  // Hook the engine sets so that loops.ts can request a drain.
  _drainHook?: () => void;

  pushScope(s: Scope): void {
    this.scopeStack.push(s);
  }
  popScope(): void {
    this.scopeStack.pop();
  }
  currentScope(): Scope {
    return this.scopeStack[this.scopeStack.length - 1]!;
  }

  currentI(): number | null {
    if (this.iStack.length === 0) return null;
    return this.iStack[this.iStack.length - 1]!;
  }
}

let currentRuntime: ProcessorRuntime | null = null;

export function getCurrentRuntime(): ProcessorRuntime {
  if (!currentRuntime)
    throw new Error(
      "unworklet primitive used outside a processor invocation. Did you forget to call createNode/renderOffline?",
    );
  return currentRuntime;
}

export function setCurrentRuntime(r: ProcessorRuntime | null): void {
  currentRuntime = r;
}

export function defineProcessor(
  body: ProcessorBody,
  options?: ProcessorOptions,
): CompiledProcessor {
  return {
    __isCompiledProcessor: true,
    body,
    options,
  };
}

let subgraphIdCounter = 0;
export function nextSubgraphId(): number {
  return subgraphIdCounter++;
}
