import type { ApiEntry } from "./types.ts";

function sample(expression: string, declarations = "", body = ""): string {
  return `const input = audioInput({ channels: 2, name: "main" });
const out = audioOutput({ channels: 2, name: "main" });
${declarations}
process(() => {
  forSample((i) => {
    ${body}
    const value = ${expression};
    out.left[i] = value;
    out.right[i] = value;
  });
});`;
}

const numericDetails = [
  "Use inside process / forSample to construct DSP values. Matching Node scalar types are required; use f32(x) or i32(x) to convert explicitly. Number literals adopt the other operand’s type; i64 needs bigint literals through i64(...).",
  "The example is a complete, single-file Playground processor with a main output. Copying it does not replace your editor.",
];
const numeric: [string, string, string][] = [
  ["add", "Add signals or an offset.", "add(f32(0.25), 0.1)"],
  ["sub", "Subtract a signal or offset.", "sub(f32(0.25), 0.1)"],
  ["mul", "Multiply signals; scale amplitude or apply gain.", "mul(f32(0.25), 0.5)"],
  [
    "div",
    "Divide signals. Always keep the divisor safe, including unselected branches.",
    "div(f32(0.25), 2)",
  ],
  ["mod", "Remainder for phase wrapping or circular-buffer indices.", "mod(f32(1.25), 1)"],
  ["neg", "Negate a value; invert signal polarity.", "neg(f32(0.25))"],
  ["sin", "Sine of an angle in radians; shape an oscillator.", "sin(f32(0.25))"],
  ["cos", "Cosine of an angle in radians.", "cos(f32(0.25))"],
  ["tan", "Tangent of an angle in radians. Avoid its singularities.", "tan(f32(0.25))"],
  ["tanh", "Hyperbolic tangent for smooth saturation and distortion.", "tanh(f32(0.25))"],
  ["exp", "Natural exponential; useful for pitch and gain conversion.", "exp(f32(-1))"],
  ["log", "Natural logarithm. Use a positive input.", "log(f32(1.25))"],
  [
    "pow",
    "Raise a value to a power. Keep fractional-power bases nonnegative.",
    "pow(f32(0.25), 2)",
  ],
  ["sqrt", "Square root of a nonnegative value.", "sqrt(f32(0.25))"],
  ["floor", "Round down to an integer-valued float; quantize a signal.", "floor(f32(0.25))"],
  ["ceil", "Round up to an integer-valued float.", "ceil(f32(0.25))"],
  ["frac", "Fractional part of a float, x minus floor(x).", "frac(f32(1.25))"],
  ["abs", "Absolute value; measure signal magnitude.", "abs(f32(-0.25))"],
  ["min", "Choose the smaller value.", "min(f32(0.25), 0.1)"],
  ["max", "Choose the larger value.", "max(f32(0.25), 0.1)"],
  [
    "clamp",
    "Limit a value to a lower and upper bound; clip amplitude.",
    "clamp(f32(0.75), -0.5, 0.5)",
  ],
];
const comparison: [string, string, string][] = [
  ["eq", "Compare equality; returns a bool DSP value.", "eq(f32(0.25), 0.25)"],
  ["lt", "Compare less than; returns a bool DSP value.", "lt(f32(0.25), 1)"],
  ["gt", "Compare greater than; returns a bool DSP value.", "gt(f32(0.25), 0)"],
  ["lte", "Compare less than or equal.", "lte(f32(0.25), 1)"],
  ["gte", "Compare greater than or equal.", "gte(f32(0.25), 0)"],
  ["not", "Invert a bool DSP value.", "not(bool(false))"],
  [
    "and",
    "Logical AND on bool values. Both operands evaluate; no short-circuit.",
    "and(bool(true), bool(false))",
  ],
  [
    "or",
    "Logical OR on bool values. Both operands evaluate; no short-circuit.",
    "or(bool(true), bool(false))",
  ],
];
const scalarTypes = ["f32", "f64", "i32", "i64", "bool"] as const;
const initial = { f32: "0.25", f64: "0.25", i32: "1", i64: "1n", bool: "true" };
const bufferSource = sample(
  "memory.readInterpolated(f32(0.5))",
  "const memory = state.buffer.f32({ size: 16 }).named();",
  "memory.write(i, input.left[i]);",
);
const stateSource = sample(
  "level.read()",
  "const level = state.f32(0.25).named();",
  "level.write(level * 0.99);",
);
const paramSource = sample(
  "input.left[i] * gain.at(i)",
  'const gain = param.f32({ default: 0.5, min: 0, max: 1, automationRate: "a-rate" });',
);
const midiSource = `const out = audioOutput({ channels: 1, name: "main" });
const keys = event.midi({ from: "main", name: "keys", capacity: CAPACITY_16 });
const velocity = state.f32(0);
process(() => {
  keys.onEvent("noteOn", (message) => velocity.write(f32(message.velocity) / 127));
  forSample((i) => { out.ch(0)[i] = velocity * 0.1; });
});`;
const eventSource = `const out = audioOutput({ channels: 1, name: "main" });
const control = event<{ value: number }>({ from: "main", name: "control", capacity: CAPACITY_16 });
const meter = event<{ value: number }>({ to: "main", name: "meter", capacity: CAPACITY_16 });
const level = state.f32(0.25);
process(() => {
  control.onReceive((message) => level.write(message.value));
  forSample((i, everyNSamples) => {
    out.ch(0)[i] = level;
    everyNSamples(128, () => { meter.emitIf(bool(true), { value: level }); });
  });
});`;
const subgraphSource = sample(
  "lp.tick(input.left[i])",
  `const onepole = defineSubgraph((coefficient: Node<"f32">) => ({
  tick: (x: Node<"f32">) => coefficient * x + (1 - coefficient) * $prev,
}));
const lp = instantiate(onepole, f32(0.2), { name: "lp" });`,
);

function entry(
  name: string,
  category: string,
  summary: string,
  example: string,
  details: string[],
  scope: ApiEntry["scope"] = "Global",
  probe?: string,
): ApiEntry {
  return { id: name, name, category, summary, example, details, scope, probe };
}

export const apiEntries: ApiEntry[] = [
  ...numeric.map(([name, summary, expression]) =>
    entry(name, "Math", summary, sample(expression), numericDetails),
  ),
  ...comparison.map(([name, summary, expression]) =>
    entry(name, "Comparison / logic", summary, sample(`select(${expression}, f32(0.25), 0)`), [
      'Use inside process / forSample. Comparisons produce Node<"bool">; and / or require bool operands. Both operands are evaluated.',
    ]),
  ),
  entry(
    "select",
    "Comparison / logic",
    "Choose one of two values using a DSP bool condition.",
    sample("select(gt(input.left[i], 0), input.left[i], 0)"),
    [
      "Both candidates evaluate. select, &&, ||, and DSP ?: do not short-circuit; an unchosen i32 division by zero can still trap. Make every operand safe.",
    ],
  ),
  ...scalarTypes.map((name) =>
    entry(
      name,
      "Math",
      `Construct a ${name} DSP value${name === "i64" ? " from bigint" : " or convert a scalar DSP value"}.`,
      sample(`f32(${name}(${initial[name]}))`),
      [
        name === "i64"
          ? "i64 takes bigint, not a JavaScript number. Use i64(1n); no implicit number lifting."
          : "Use inside process / forSample. Audio output requires f32; f32(...) explicitly converts other scalar Node types.",
      ],
    ),
  ),
  entry(
    "pipe",
    "Math",
    "Thread a DSP value through functions in order.",
    sample("pipe(f32(0.25), (value) => mul(value, 0.5), tanh)"),
    [
      "The functions receive and return DSP Nodes. The example uses the global pipe; value.pipe(fn) is also available.",
    ],
  ),
  {
    ...entry(
      "audioInput",
      "I/O",
      "Declare an audio input port and read its channels.",
      sample("input.ch(0).at(i)"),
      [
        "Declare before process. left / right require exactly two channels; ch(index) works for mono or multichannel ports. at(i) reads inside forSample.",
        "When explicit audio input is omitted, ambient input is stereo and named input. The demo examples explicitly name their ports main.",
      ],
    ),
    aliases: ["input"],
  },
  {
    ...entry(
      "audioOutput",
      "I/O",
      "Declare an audio output port and write sample values.",
      sample("input.left[i]"),
      [
        "Declare before process. Use output.ch(channel).at(i).write(value), or output.left[i] = value. The demo engine requires an output named main.",
        'When explicit audio output is omitted, ambient out is stereo and named out. Set name: "main" for a complete Playground example.',
      ],
    ),
    aliases: ["out"],
  },
  entry(
    "input.ch",
    "I/O",
    "Select an input channel by its zero-based index.",
    sample("input.ch(0).at(i)"),
    [
      "Member of an audioInput handle. Channel must exist. Read the returned channel view with at(i) inside forSample.",
    ],
    "Member",
  ),
  entry(
    "input.left.at",
    "I/O",
    "Read one stereo input sample.",
    sample("input.left.at(i)"),
    [
      "Member of the left channel on a two-channel input. input.left[i] is the corresponding sugar.",
    ],
    "Member",
  ),
  entry(
    "out.ch",
    "I/O",
    "Select the output channel to write.",
    sample("input.ch(0)[i]"),
    ["Member of audioOutput. ch(0) works for mono; left/right are only valid for stereo."],
    "Member",
  ),
  entry(
    "output sample.write",
    "I/O",
    "Write an f32 value to an output sample.",
    `const out = audioOutput({ channels: 1, name: "main" });
process(() => { forSample((i) => { out.ch(0).at(i).write(f32(0.25)); }); });`,
    [
      "Member of the sample returned by out.ch(channel).at(i). Use inside forSample. Nonfinite samples are scrubbed at the output boundary.",
    ],
    "Member",
    "out.left.at(i32(0)).write",
  ),
  entry(
    "param.f32",
    "Param / state / buffer",
    "Declare an automatable float parameter with default, range, and rate.",
    paramSource,
    [
      "Declare before process. Required options: default, min, max, automationRate. Read with gain[i] or gain.at(i) inside forSample.",
      "A top-level binding supplies the missing name. a-rate varies per sample; k-rate is constant within a block.",
    ],
  ),
  entry(
    "param.at",
    "Param / state / buffer",
    "Read an AudioParam at the current sample.",
    paramSource,
    [
      "Member of a param.f32 handle, not of the global param factory. gain[i] lowers to gain.at(i).",
    ],
    "Member",
    'param.f32({ default: 1, min: 0, max: 2, automationRate: "a-rate" }).at',
  ),
  ...scalarTypes.map((type) =>
    entry(
      `state.${type}`,
      "Param / state / buffer",
      `Declare persistent-in-time ${type} scalar memory for DSP.`,
      sample(
        "f32(memory.read())",
        `const memory = state.${type}(${initial[type]}).named();`,
        `memory.write(${type}(${initial[type]}));`,
      ),
      [
        "Declare before process. read() captures the value at that point; write(value) updates it. Bare-state value use can auto-read, but scalar assignment is not sugar.",
        "Plain state is anonymous; .named() opts into binding-derived naming. Named scalar state defaults to persistent snapshots. Use bigint for i64 and boolean for bool initial values.",
      ],
    ),
  ),
  ...[...scalarTypes, "u8"].map((type) =>
    entry(
      `state.buffer.${type}`,
      "Param / state / buffer",
      `Declare a fixed-size ${type} buffer for delay, history, or tables.`,
      type === "f32"
        ? bufferSource
        : sample(
            "f32(memory.read(i))",
            `const memory = state.buffer.${type}({ size: 128 }).named();`,
            `memory.write(i, ${type === "u8" ? "i32(1)" : `${type}(${initial[type as keyof typeof initial]})`});`,
          ),
      [
        "Declare before process with a fixed size. Inside forSample, read(index) / write(index, value), or memory[index] / memory[index] = value, access elements.",
        'Literal indices must be in range. Runtime i32 indices saturate to the nearest valid element; circular wrapping must be explicit. Buffers default to transient snapshots; use expose({ snapshot: "persistent" }) with a name to retain them.',
        ...(type === "u8" ? ["u8 reads return i32 Nodes."] : []),
      ],
    ),
  ),
  entry(
    "state.read",
    "Param / state / buffer",
    "Read a scalar state at a precise point in the graph.",
    stateSource,
    [
      "Member of a scalar state handle. A later write does not change an already-bound read. Bare-state sugar supplies read() in value positions.",
    ],
    "Member",
    "state.f32(0).read",
  ),
  entry(
    "state.write",
    "Param / state / buffer",
    "Store a scalar value for subsequent reads.",
    stateSource,
    [
      "Member of a scalar state handle. Use memory.write(value); memory = value and memory += value are not DSP write sugar.",
    ],
    "Member",
    "state.f32(0).write",
  ),
  entry(
    "buffer.read",
    "Param / state / buffer",
    "Read a fixed-size buffer element.",
    bufferSource,
    [
      "Member of state.buffer.<type> handles. Accepts an i32 Node or literal index; runtime indices saturate.",
    ],
    "Member",
    "state.buffer.f32({ size: 16 }).read",
  ),
  entry(
    "buffer.write",
    "Param / state / buffer",
    "Store a value at a buffer index.",
    bufferSource,
    [
      "Member of state.buffer.<type> handles. buf[i] = value is equivalent sugar. Declare the buffer before process.",
    ],
    "Member",
    "state.buffer.f32({ size: 16 }).write",
  ),
  entry(
    "buffer.readInterpolated",
    "Param / state / buffer",
    "Read between adjacent buffer elements using two-tap interpolation.",
    bufferSource,
    [
      "Member of a buffer handle. The position is f32 or number. Useful for fractional delay reads.",
    ],
    "Member",
    "state.buffer.f32({ size: 16 }).readInterpolated",
  ),
  entry(
    "state.named",
    "Param / state / buffer",
    "Give a state slot an identity for snapshots and inspection.",
    stateSource,
    [
      'Member of scalar/buffer handles and factories. .named() at a top-level binding derives its name; explicit .named("name") wins. Plain state.f32(0) remains anonymous.',
    ],
    "Member",
    "state.f32(0).named",
  ),
  entry(
    "state.expose",
    "Param / state / buffer",
    "Configure naming, snapshots, and scalar publication.",
    sample(
      "meter",
      'const meter = state.f32(0.25).expose({ name: "meter", publish: { rateFps: 30 } });',
    ),
    [
      "Member of state handles/factories. Scalar publication supports f32, i32, bool; requires a name and positive finite rateFps. Buffers cannot publish; buffer expose supports naming and snapshots.",
    ],
    "Member",
    "state.f32(0).expose",
  ),
  entry(
    "event",
    "Event / MIDI",
    "Declare a typed message port to or from the main thread.",
    eventSource,
    [
      'Declare before process. from: "main" gives onReceive(handler); to: "main" gives emitIf(condition, payload). Use a bounded capacity. Typed-array messages also need an appropriate payloadCapacity budget.',
      "Outbound handles have no unconditional emit method: use emitIf(bool(true), payload). Conditional emit syntax is explained in the sugar guide.",
    ],
  ),
  entry(
    "event.onReceive",
    "Event / MIDI",
    "Handle an inbound typed message in process.",
    eventSource,
    [
      'Member of an event({ from: "main" }) handle. Receive callbacks build DSP; keep persistent results in declared state.',
    ],
    "Member",
    'event<{ value: number }>({ from: "main", name: "control" }).onReceive',
  ),
  entry(
    "event.emitIf",
    "Event / MIDI",
    "Conditionally send a typed payload to the main thread.",
    eventSource,
    [
      'Member of an event({ to: "main" }) handle. Payload values still evaluate. Omitted atSample uses the enclosing forSample index, or zero at block level.',
    ],
    "Member",
    'event<{ value: number }>({ to: "main", name: "meter" }).emitIf',
  ),
  entry("event.midi", "Event / MIDI", "Declare a MIDI input or output port.", midiSource, [
    'Declare before process. from: "main" returns an input with onEvent; to: "main" returns an output with emitIf.',
    "MIDI handler fields such as note and velocity are i32 Nodes. Convert with f32(...) for audio math. This example is silent until it receives noteOn.",
  ]),
  entry(
    "midi.onEvent",
    "Event / MIDI",
    "Handle a MIDI message type such as noteOn.",
    midiSource,
    [
      'Member of event.midi({ from: "main" }). Place the handler in process. Event fields depend on the message type; note/velocity/channel are i32 Nodes.',
    ],
    "Member",
    'event.midi({ from: "main", name: "keys" }).onEvent',
  ),
  entry(
    "midi.emitIf",
    "Event / MIDI",
    "Send a MIDI event when a DSP bool condition is true.",
    `const out = audioOutput({ channels: 1, name: "main" });
const notes = event.midi({ to: "main", name: "notes", capacity: CAPACITY_16 });
process(() => {
  notes.emitIf(bool(true), { type: "noteOn", channel: 0, note: 60, velocity: 64, atSample: 0 });
  forSample((i) => { out.ch(0)[i] = f32(0); });
});`,
    [
      "Member of an outbound MIDI handle. Include type-specific fields and atSample, the index within this quantum. There is no bare emit method.",
    ],
    "Member",
    'event.midi({ to: "main", name: "notes" }).emitIf',
  ),
  entry(
    "forSample",
    "Loop / subgraph",
    "Build sample-by-sample DSP across a 128-sample render quantum.",
    sample("input.left[i]"),
    [
      "Call inside process. The first callback parameter is an i32 sample index. The second is everyNSamples; it is not a global.",
    ],
  ),
  entry(
    "forSample.byN",
    "Loop / subgraph",
    "Run a loop at a fixed sample stride.",
    `const out = audioOutput({ channels: 1, name: "main" });
process(() => { forSample.byN(2, (i) => { out.ch(0)[i] = f32(0.25); }); });`,
    [
      "Member of forSample. Stride must be a power of two dividing 128: 1, 2, 4, 8, 16, 32, 64, 128. Skipped output samples are not written by this loop.",
    ],
    "Member",
  ),
  entry(
    "everyNSamples",
    "Loop / subgraph",
    "Run sub-rate work once per fixed number of samples.",
    eventSource,
    [
      "The second callback parameter of forSample, not an ambient global. Write forSample((i, everyNSamples) => { everyNSamples(128, () => { ... }); }). n must be a compile-time positive integer.",
    ],
    "Callback parameter",
    "null as unknown as Parameters<Parameters<typeof forSample>[0]>[1]",
  ),
  entry(
    "defineSubgraph",
    "Loop / subgraph",
    "Define a reusable DSP module with local state and methods.",
    subgraphSource,
    [
      "Declare before process, instantiate once per independent voice/channel, then call a method inside forSample. Node<T> and State<T> types are ambient.",
      "$prev inside a method means that method’s previous-call return value, not necessarily the previous sample.",
    ],
  ),
  entry(
    "instantiate",
    "Loop / subgraph",
    "Create an independent subgraph instance and its state.",
    subgraphSource,
    [
      "Use before process with a defineSubgraph declaration, its arguments, and { name }. Separate instances hold independent feedback state.",
    ],
  ),
  entry(
    "$prev",
    "Loop / subgraph",
    "Read a subgraph method’s previous-call return value.",
    subgraphSource,
    [
      "Contextual ambient binding inside defineSubgraph methods. Hidden feedback state is per method and per instance. Multiple calls in one sample still count as separate calls.",
    ],
    "Ambient binding",
  ),
  entry(
    "noiseSource",
    "Math",
    "Create a seeded deterministic pseudo-random source.",
    sample("noise.next() * 0.1", "const noise = noiseSource({ seed: 12345 });"),
    [
      "Declare before process, call next() inside sample DSP. An unselected next() still advances the generator.",
    ],
  ),
  entry(
    "noise.next",
    "Math",
    "Advance a noise source and return its next f32 sample.",
    sample("noise.next() * 0.1", "const noise = noiseSource({ seed: 12345 });"),
    [
      "Member of a noiseSource handle. It advances even when its value is not selected by select / ?: .",
    ],
    "Member",
    "noiseSource({ seed: 12345 }).next",
  ),
  entry(
    "process",
    "Loop / subgraph",
    "Declare the single processor body for this .uwk.ts file.",
    sample("f32(0.25)"),
    [
      "Exactly one process callback is required for a runnable Playground processor. State/port declarations go before it. No defineProcessor wrapper or extra module exports are needed.",
    ],
  ),
  entry(
    "ctx.sampleRate",
    "I/O",
    "Read the compile-time sample rate as an ordinary JavaScript number.",
    sample("f32(220 / ctx.sampleRate)"),
    [
      "ctx is an ambient ProcessorContext. Pure number arithmetic stays build-time JavaScript; combine with a DSP Node to construct DSP math.",
    ],
    "Ambient binding",
  ),
  entry(
    "options",
    "Loop / subgraph",
    "Set processor options, including stable snapshot identity.",
    `${sample("f32(0.25)")}\noptions({ id: "playground-help" });`,
    [
      "Processor-only macro. An id identifies compatible snapshots; changing it changes that identity. Options cannot reference process-local bindings.",
    ],
  ),
  entry(
    "migrations",
    "Loop / subgraph",
    "Declare snapshot migrations for a processor.",
    `${sample("f32(0.25)")}\nmigrations([]);`,
    [
      "Processor-only macro. A migration list is supplied outside process and cannot reference process-local bindings. Consult the source reference before migrating saved state.",
    ],
  ),
  {
    ...entry(
      "SAMPLES_PER_BLOCK",
      "Loop / subgraph",
      "Render-quantum size (128) and bounded event ring capacities.",
      sample("f32(1 / SAMPLES_PER_BLOCK)"),
      [
        "Global compile-time constants. CAPACITY_16 through CAPACITY_16384 are powers of two for event/MIDI capacity options; buffer size is a separate option.",
      ],
    ),
    aliases: Array.from({ length: 11 }, (_, index) => `CAPACITY_${16 * 2 ** index}`),
  },
];
