import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { Example } from "../examples.ts";
import { useUnworkletDemo } from "./useUnworkletDemo.ts";

const { compileSource, createNode, replaceProcessor } = vi.hoisted(() => ({
  compileSource: vi.fn(),
  createNode: vi.fn(),
  replaceProcessor: vi.fn(),
}));
vi.mock("@unworklet/lang/browser", () => ({ compileSource }));
vi.mock("@unworklet/core", () => ({ createNode, replaceProcessor }));

// A deterministic main-thread graph: DSP output is a constant signal or an
// input passthrough. Gain automation is evaluated at the context's audio time.
class Param {
  value = 1;
  events: { value: number; time: number; ramp: boolean }[] = [];
  setValueAtTime(value: number, time: number) {
    this.events.push({ value, time, ramp: false });
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.events.push({ value, time, ramp: true });
  }
  at(time: number): number {
    let previous = { value: this.value, time: 0 };
    for (const event of this.events) {
      if (event.time > time) {
        return event.ramp
          ? previous.value +
              ((event.value - previous.value) * (time - previous.time)) /
                (event.time - previous.time)
          : previous.value;
      }
      previous = event;
    }
    return previous.value;
  }
}

class GraphNode {
  inputs = new Set<GraphNode>();
  targets = new Set<GraphNode>();
  connect(target: GraphNode) {
    target.inputs.add(this);
    this.targets.add(target);
  }
  disconnect() {
    for (const target of this.targets) target.inputs.delete(this);
    this.targets.clear();
  }
  signal(time: number): number {
    return [...this.inputs].reduce((sum, input) => sum + input.signal(time), 0);
  }
}

class Gain extends GraphNode {
  gain = new Param();
  override signal(time: number): number {
    return super.signal(time) * this.gain.at(time);
  }
}

class Oscillator extends GraphNode {
  frequency = new Param();
  type = "sawtooth";
  started = false;
  stopped = false;
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  override signal(): number {
    return this.started && !this.stopped ? 0.5 : 0;
  }
}

class Context {
  currentTime = 0;
  state = "running";
  sampleRate = 48000;
  destination = new GraphNode();
  oscillators: Oscillator[] = [];
  resume = vi.fn(async () => {
    this.state = "running";
  });
  close = vi.fn(async () => {
    this.state = "closed";
  });
  createGain() {
    return new Gain();
  }
  createOscillator() {
    const oscillator = new Oscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }
  level() {
    return this.destination.signal(this.currentTime);
  }
}

class Processor {
  inputs: Record<string, GraphNode> = {};
  outputs: Record<string, GraphNode>;
  params = {};
  gate = false;
  midi = {
    keys: {
      send: (event: { type: string }) => {
        this.gate = event.type === "noteOn";
      },
    },
  };
  onError = vi.fn();
  dispose = vi.fn(() => this.outputs.main!.disconnect());

  constructor(kind: string) {
    const output = new GraphNode();
    this.outputs = { main: output };
    if (kind === "effect") {
      const input = new GraphNode();
      this.inputs.main = input;
      input.connect(output);
    } else {
      output.signal = () => (kind === "instrument" ? (this.gate ? 0.2 : 0) : 0.5);
    }
  }
}

function example(source = "generator", kind: Example["kind"] = "effect"): Example {
  return { slug: source, title: source, blurb: "", source, kind, midiPort: "keys" };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

let context: Context;
let processors: Processor[];
let demo: ReturnType<typeof useUnworkletDemo>;

beforeEach(() => {
  vi.useFakeTimers();
  context = new Context();
  processors = [];
  vi.stubGlobal(
    "AudioContext",
    class extends Context {
      constructor() {
        super();
        return context;
      }
    },
  );
  vi.stubGlobal("OscillatorNode", Oscillator);
  vi.stubGlobal("window", globalThis);
  compileSource.mockReset().mockImplementation(async (source: string) => source);
  const instantiate = (source: string) => {
    const processor = new Processor(source);
    processors.push(processor);
    return processor;
  };
  createNode
    .mockReset()
    .mockImplementation(async (_context, source: string) => instantiate(source));
  replaceProcessor.mockReset().mockImplementation(async (old: Processor, source: string) => {
    const node = instantiate(source);
    node.gate = old.gate;
    return { node, applied: [] };
  });
  demo = useUnworkletDemo();
});

afterEach(async () => {
  await demo.destroy();
  vi.runAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("generator output is silent until Play and silenced by every Stop", async () => {
  await demo.prepare(example());
  expect(demo.ready.value).toBe(true);
  expect(demo.playing.value).toBe(false);
  expect(context.level()).toBe(0);
  for (let i = 0; i < 3; i++) {
    await demo.play();
    expect(demo.playing.value).toBe(true);
    expect(context.level()).toBeCloseTo(0.45);
    demo.stop();
    demo.stop();
    expect(demo.playing.value).toBe(false);
    expect(context.level()).toBe(0);
  }
  expect(context.oscillators).toHaveLength(0);
});

test("recompiling a stopped generator never opens the output gate", async () => {
  await demo.prepare(example());
  await demo.recompile("generator");
  for (const time of [0, 0.02, 0.08, 1]) {
    context.currentTime = time;
    expect(context.level()).toBe(0);
  }
  await demo.play();
  expect(context.level()).toBeCloseTo(0.45);
  demo.stop();
  await demo.recompile("generator");
  context.currentTime = 2;
  expect(context.level()).toBe(0);
});

test("Stop silences both sides of an active crossfade and Play can resume it", async () => {
  await demo.prepare(example());
  await demo.play();
  await demo.recompile("generator");
  context.currentTime = 0.02;
  expect(context.level()).toBeCloseTo(0.45);
  demo.stop();
  expect(context.level()).toBe(0);
  context.currentTime = 0.04;
  expect(context.level()).toBe(0);
  await demo.play();
  expect(context.level()).toBeCloseTo(0.45);
  demo.stop();
  context.currentTime = 1;
  vi.runAllTimers();
  expect(context.level()).toBe(0);
  expect(processors[0]!.dispose).toHaveBeenCalledOnce();
});

test.each(["compile", "replace"])(
  "Stop during pending %s keeps the replacement silent",
  async (stage) => {
    await demo.prepare(example());
    await demo.play();
    const pending = deferred<void>();
    if (stage === "compile")
      compileSource.mockImplementationOnce(async () => {
        await pending.promise;
        return "generator";
      });
    else
      replaceProcessor.mockImplementationOnce(async () => {
        await pending.promise;
        const node = new Processor("generator");
        processors.push(node);
        return { node, applied: [] };
      });
    const recompiling = demo.recompile("generator");
    await Promise.resolve();
    demo.stop();
    pending.resolve();
    await recompiling;
    context.currentTime = 1;
    expect(demo.playing.value).toBe(false);
    expect(context.level()).toBe(0);
  },
);

test("Play during compilation uses the latest transport state", async () => {
  await demo.prepare(example());
  const pending = deferred<string>();
  compileSource.mockReturnValueOnce(pending.promise);
  const recompiling = demo.recompile("generator");
  await demo.play();
  pending.resolve("generator");
  await recompiling;
  context.currentTime = 1;
  expect(context.level()).toBeCloseTo(0.45);
});

test("Stop cancels an in-flight context resume without restarting the source", async () => {
  await demo.prepare(example("effect"));
  context.state = "suspended";
  const pending = deferred<void>();
  context.resume.mockReturnValueOnce(pending.promise);
  const playing = demo.play();
  demo.stop();
  pending.resolve();
  await playing;
  expect(demo.playing.value).toBe(false);
  expect(context.oscillators).toHaveLength(0);
  expect(context.level()).toBe(0);
});

test("an older Play cannot replace the source created by a newer Play", async () => {
  await demo.prepare(example("effect"));
  context.state = "suspended";
  const pending = deferred<void>();
  context.resume.mockReturnValueOnce(pending.promise);
  const older = demo.play();
  await demo.play();
  const source = context.oscillators[0]!;
  pending.resolve();
  await older;
  expect(context.oscillators).toHaveLength(1);
  expect(source.stopped).toBe(false);
  expect(context.level()).toBeCloseTo(0.45);
});

test.each([false, true])("destroy cancels a pending Play (resume rejects: %s)", async (reject) => {
  await demo.prepare(example("effect"));
  context.state = "suspended";
  const pending = deferred<void>();
  context.resume.mockReturnValueOnce(pending.promise);
  const playing = demo.play();
  await demo.destroy();
  if (reject) pending.reject(new Error("context closed"));
  else pending.resolve();
  await expect(playing).resolves.toBeUndefined();
  expect(demo.playing.value).toBe(false);
  expect(context.oscillators).toHaveLength(0);
  expect(context.level()).toBe(0);
});

test("destroy cleans up both sides of an unfinished crossfade", async () => {
  await demo.prepare(example());
  await demo.play();
  await demo.recompile("generator");
  context.currentTime = 0.04;
  await demo.destroy();
  expect(context.level()).toBe(0);
  expect(processors.every((node) => node.dispose.mock.calls.length === 1)).toBe(true);
  vi.runAllTimers();
  expect(processors.every((node) => node.dispose.mock.calls.length === 1)).toBe(true);
});

test("switching between input effects and generators preserves playback", async () => {
  await demo.prepare(example("effect"));
  await demo.play();
  expect(context.level()).toBeCloseTo(0.45);
  await demo.recompile("generator");
  context.currentTime = 1;
  expect(context.oscillators[0]!.stopped).toBe(true);
  expect(context.level()).toBeCloseTo(0.45);
  await demo.recompile("effect");
  context.currentTime = 2;
  expect(context.level()).toBeCloseTo(0.45);
  demo.stop();
  expect(context.oscillators.every((source) => source.stopped)).toBe(true);
  expect(context.level()).toBe(0);
});

test("MIDI instruments remain key-triggered without a Play transport", async () => {
  await demo.prepare(example("instrument", "instrument"));
  expect(context.level()).toBe(0);
  demo.noteOn(60);
  expect(demo.playing.value).toBe(false);
  expect(context.level()).toBeCloseTo(0.18);
  await demo.recompile("instrument");
  context.currentTime = 1;
  expect(context.level()).toBeCloseTo(0.18);
  demo.noteOff(60);
  expect(context.level()).toBe(0);
});

test.each(["compile", "create"])(
  "destroy during prepare's pending %s cannot reconnect output",
  async (stage) => {
    const pending = deferred<void>();
    if (stage === "compile")
      compileSource.mockImplementationOnce(async () => {
        await pending.promise;
        return "generator";
      });
    else
      createNode.mockImplementationOnce(async () => {
        await pending.promise;
        const node = new Processor("generator");
        processors.push(node);
        return node;
      });
    const preparing = demo.prepare(example());
    await vi.waitFor(() =>
      expect(stage === "compile" ? compileSource : createNode).toHaveBeenCalled(),
    );
    await demo.destroy();
    pending.resolve();
    await preparing;
    expect(demo.ready.value).toBe(false);
    expect(demo.busy.value).toBe(false);
    expect(context.level()).toBe(0);
    expect(processors.every((node) => node.dispose.mock.calls.length === 1)).toBe(true);
  },
);

test("destroy during a pending recompile disposes its late replacement", async () => {
  await demo.prepare(example());
  await demo.play();
  const pending = deferred<void>();
  replaceProcessor.mockImplementationOnce(async () => {
    await pending.promise;
    const node = new Processor("generator");
    processors.push(node);
    return { node, applied: [] };
  });
  const recompiling = demo.recompile("generator");
  await vi.waitFor(() => expect(replaceProcessor).toHaveBeenCalled());
  await demo.destroy();
  pending.resolve();
  await recompiling;
  expect(context.level()).toBe(0);
  expect(processors.every((node) => node.dispose.mock.calls.length === 1)).toBe(true);
});

test("a newer prepare owns the output even when an older compile finishes last", async () => {
  const pending = deferred<string>();
  compileSource.mockReturnValueOnce(pending.promise);
  const older = demo.prepare(example());
  await vi.waitFor(() => expect(compileSource).toHaveBeenCalled());
  await demo.prepare(example("instrument", "instrument"));
  pending.resolve("generator");
  await older;
  demo.noteOn(60);
  expect(context.level()).toBeCloseTo(0.18);
  expect(processors).toHaveLength(1);
});

test("failed recompilation leaves the active transport usable", async () => {
  await demo.prepare(example());
  await demo.play();
  compileSource.mockRejectedValueOnce(new Error("invalid source"));
  await demo.recompile("invalid");
  expect(demo.error.value).toContain("invalid source");
  expect(context.level()).toBeCloseTo(0.45);
  demo.stop();
  expect(context.level()).toBe(0);
  await demo.play();
  expect(context.level()).toBeCloseTo(0.45);
});
