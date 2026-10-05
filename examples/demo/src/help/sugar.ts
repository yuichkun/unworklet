import type { SugarEntry } from "./types.ts";

const io = `const input = audioInput({ channels: 2, name: "main" });
const out = audioOutput({ channels: 2, name: "main" });`;
function processor(declarations: string, body: string): string {
  return `${io}\n${declarations}\nprocess(() => {\n  forSample((i) => {\n    ${body}\n  });\n});`;
}
const reference = (file: string) =>
  `https://github.com/yuichkun/unworklet/blob/main/packages/lang/src/${file}`;

export const sugarEntries: SugarEntry[] = [
  {
    id: "type-directed",
    name: "JavaScript numbers vs DSP values",
    category: "Operators",
    summary:
      "Sugar is type-directed: number × number stays JavaScript; a Node / State operand builds DSP.",
    details: [
      "ctx.sampleRate is an ordinary build-time number, so ctx.sampleRate * 0.5 is not rewritten. input.left[i] and gain[i] read DSP Nodes, so their product becomes mul.",
      "Operator precedence is preserved. This is a single-file runtime: external-file imports and SIMD authoring are outside the Playground surface.",
    ],
    before: "const nyquist = ctx.sampleRate * 0.5;",
    after: ["const nyquist = ctx.sampleRate * 0.5;", "mul(input.left.at(i), gain.at(i))"],
    example: processor(
      'const gain = param.f32({ default: 0.5, min: 0, max: 1, automationRate: "a-rate" });\nconst nyquist = ctx.sampleRate * 0.5;',
      "out.left[i] = input.left[i] * gain[i];\n    out.right[i] = f32(220 / nyquist);",
    ),
    reference: reference("classify.ts"),
  },
  {
    id: "arithmetic",
    name: "Infix and unary arithmetic",
    category: "Operators",
    summary: "+ − * / % ** and unary − become the corresponding core calls for DSP values.",
    details: [
      "+ → add, − → sub, * → mul, / → div, % → mod, ** → pow, unary − → neg.",
      "Mixing differently typed Nodes requires explicit conversion. Number literals can lift to the other operand’s scalar type; i64 requires explicit bigint construction.",
    ],
    before: "const shaped = -(x + 0.1) * 0.5;",
    after: [
      "const shaped = mul(neg((add(x, 0.1))), 0.5);",
      "pow((mod(div((sub(x, 0.1)), 2), 1)), 2)",
    ],
    example: processor(
      "",
      "const x = input.left[i];\n    const shaped = -(x + 0.1) * 0.5;\n    out.left[i] = shaped;\n    out.right[i] = ((x - 0.1) / 2 % 1) ** 2;",
    ),
    reference: reference("passes/operators.ts"),
  },
  {
    id: "comparison",
    name: "Comparisons and bool operators",
    category: "Operators",
    summary: "Compare DSP values and combine bool Nodes. && and || do not short-circuit.",
    details: [
      "== / === → eq; != / !== → not(eq); < / > / <= / >= → lt / gt / lte / gte; ! → not; && / || → and / or.",
      "Both operands evaluate. Do not use a false left side to guard division by zero, invalid reads, or noise-source advancement.",
    ],
    before: "const active = (x > 0 && x <= 1) || !(x === 0);",
    after: [
      "or((and(gt(x, 0), lte(x, 1))), not((eq(x, 0))))",
      "and(and(lt(x, 1), gte(x, -1)), not(eq(x, 0.5)))",
    ],
    example: processor(
      "",
      "const x = input.left[i];\n    const active = (x > 0 && x <= 1) || !(x === 0);\n    const inside = x < 1 && x >= -1 && x !== 0.5;\n    out.left[i] = active ? 0.25 : 0;\n    out.right[i] = inside ? 0.25 : 0;",
    ),
    reference: reference("passes/operators.ts"),
  },
  {
    id: "selection",
    name: "Conditional values without short-circuit",
    category: "Operators",
    summary: "DSP condition ? a : b lowers to select(condition, a, b); both candidates evaluate.",
    details: [
      "A JavaScript boolean condition remains JavaScript. A DSP bool condition selects a value in the graph.",
      "An unchosen noise.next() still advances the generator; an unchosen i32 division by zero can still trap. Make every operand safe instead of relying on selection to skip it.",
    ],
    before: "out.left[i] = x > 0 ? x : 0;",
    after: ["out.left.at(i).write(select(gt(x, 0), x, 0));"],
    example: processor(
      "",
      "const x = input.left[i];\n    out.left[i] = x > 0 ? x : 0;\n    out.right[i] = x;",
    ),
    reference: reference("passes/operators.ts"),
  },
  {
    id: "index",
    name: "Input, param, buffer and output indexing",
    category: "Reads / writes",
    summary: "Index reads and element writes dispatch on the handle’s type.",
    details: [
      "input channel[i] → channel.at(i); gain[i] → gain.at(i); buffer[i] → buffer.read(i).",
      "out.left[i] = value → out.left.at(i).write(value); buffer[i] = value → buffer.write(i, value). Declare ports, params, and buffers before process, then index them in forSample.",
      "This is not arbitrary JavaScript array mutation or scalar state assignment.",
    ],
    before: "memory[i] = input.left[i] * gain[i];",
    after: [
      "memory.write(i, mul(input.left.at(i), gain.at(i)));",
      "out.left.at(i).write(memory.read(i));",
    ],
    example: processor(
      'const gain = param.f32({ default: 0.5, min: 0, max: 1, automationRate: "a-rate" });\nconst memory = state.buffer.f32({ size: 128 });',
      "memory[i] = input.left[i] * gain[i];\n    out.left[i] = memory[i];\n    out.right[i] = memory[i];",
    ),
    reference: reference("passes/index.ts"),
  },
  {
    id: "bare-state",
    name: "Bare state reads, explicit scalar writes",
    category: "Reads / writes",
    summary: "A scalar State used as a DSP value auto-reads. Scalar writes stay explicit.",
    details: [
      "env.write(env * 0.99) reads env and stores the result. An already-bound read keeps the value at that lexical point.",
      "env = value and env += value do not mean a DSP store. Use env.write(value). When a helper expects a State handle rather than a Node, the reference stays a handle.",
    ],
    before: "env.write(env * 0.99);",
    after: ["env.write(mul(env.read(), 0.99));"],
    example: processor(
      "const env = state.f32(0.25);",
      "env.write(env * 0.99);\n    out.left[i] = env;\n    out.right[i] = env;",
    ),
    reference: reference("passes/bareState.ts"),
  },
  {
    id: "if-writes",
    name: "DSP if: accepted state and buffer writes",
    category: "Control flow",
    summary:
      "A single guarded write becomes a select. Both paths of if/else must write the same target.",
    details: [
      "Accepted: if (condition) state.write(value); a missing else retains the old state. Also accepted: if (condition) buffer[i] = value.",
      "Accepted: if (condition) state.write(a); else state.write(b); with the same target. These shapes build branch-free selections; values still evaluate.",
      "Rejected: multi-write blocks, arbitrary function calls, output-sample assignment, or if/else writes to different targets under a DSP condition. The error is uwk-unsupported-if. Split guarded writes or use select explicitly.",
    ],
    before: "if (x > 0) level.write(x);",
    after: [
      "level.write(select(gt(x, 0), x, level.read()));",
      "memory.write(i, select(gt(x, 0), x, memory.read(i)));",
      "level.write(select(gt(x, 0), x, 0));",
    ],
    example: processor(
      "const level = state.f32(0);\nconst memory = state.buffer.f32({ size: 128 });",
      "const x = input.left[i];\n    if (x > 0) level.write(x);\n    if (x > 0) memory[i] = x;\n    if (x > 0) level.write(x); else level.write(0);\n    out.left[i] = level;\n    out.right[i] = memory[i];",
    ),
    reference: reference("passes/ifSugar.ts"),
  },
  {
    id: "if-events",
    name: "DSP if: conditional event emission",
    category: "Control flow",
    summary: "A guarded emit, or a block containing only emits, becomes emitIf.",
    details: [
      "if (condition) meter.emit(payload) is syntax sugar for meter.emitIf(condition, payload). There is no unconditional emit on a worklet-side handle.",
      "Use meter.emitIf(bool(true), payload) to send unconditionally. Mixing writes and emits in one DSP if block is unsupported; split them into individually guarded statements.",
    ],
    before: "if (x > 0.5) meter.emit({ value: x });",
    after: ["meter.emitIf(gt(x, 0.5), { value: x });"],
    example: processor(
      'const meter = event<{ value: number }>({ to: "main", name: "meter", capacity: CAPACITY_16 });',
      "const x = input.left[i];\n    if (x > 0.5) meter.emit({ value: x });\n    out.left[i] = x;\n    out.right[i] = x;",
    ),
    reference: reference("passes/ifSugar.ts"),
  },
  {
    id: "previous-call",
    name: "$prev is the previous method call",
    category: "Subgraphs / naming",
    summary:
      "Inside a defineSubgraph method, $prev holds that method’s previous-call return value.",
    details: [
      "Lowering injects a hidden state slot per method and per instance, reads it for $prev, and writes each returned value back to that slot.",
      "It is not unconditionally the previous sample: if you call a method twice within one sample, the second call sees the first call’s result. The shown lower-output fragments use generated names from this exact example.",
    ],
    before: 'tick: (x: Node<"f32">) => x * 0.2 + $prev * 0.8,',
    after: [
      "const __prev_0 = state.f32(0);",
      "const __r = add(mul(x, 0.2), mul(__prev_0.read(), 0.8));",
      "__prev_0.write(__r);",
      "return __r;",
    ],
    example: processor(
      'const filter = defineSubgraph(() => ({\n  tick: (x: Node<"f32">) => x * 0.2 + $prev * 0.8,\n}));\nconst voice = instantiate(filter, { name: "voice" });',
      "out.left[i] = voice.tick(input.left[i]);\n    out.right[i] = input.right[i];",
    ),
    reference: reference("passes/prev.ts"),
  },
  {
    id: "naming",
    name: "Auto-name, .named(), and explicit names",
    category: "Subgraphs / naming",
    summary:
      "Top-level binding names fill missing required names. Plain scalar state remains anonymous.",
    details: [
      "param, audioInput, audioOutput, event, and event.midi derive required names from a single top-level const binding. Explicit names take priority.",
      "State and buffer names are optional: only a no-argument .named() or .expose({ ... }) marker without a name opts into auto-naming. Plain state.f32(0) is not auto-named.",
      "Use one binding per const statement. Nested declarations and comma-separated bindings do not participate in the same top-level rule.",
    ],
    before: "const anonymous = state.f32(0);",
    after: [
      "const anonymous = state.f32(0);",
      'const meter = state.f32(0.25).named("meter");',
      'const fixed = state.f32(0).named("explicit");',
      'const exposed = state.f32(0).expose({ name: "exposed" });',
      'param.f32({ default: 1, min: 0, max: 2, automationRate: "a-rate" }).named("gain")',
    ],
    example: processor(
      'const anonymous = state.f32(0);\nconst meter = state.f32(0.25).named();\nconst fixed = state.f32(0).named("explicit");\nconst exposed = state.f32(0).expose({});\nconst gain = param.f32({ default: 1, min: 0, max: 2, automationRate: "a-rate" });',
      "out.left[i] = meter * gain[i];\n    out.right[i] = f32(0);",
    ),
    reference: reference("passes/autoName.ts"),
  },
  {
    id: "ambient",
    name: "Ambient input, out, and ctx",
    category: "Subgraphs / naming",
    summary: "The .uwk.ts file is the processor body; DSL names and ctx need no imports.",
    details: [
      "With no explicit audio declarations, lowering injects stereo input named input and out named out. An explicit declaration suppresses the corresponding injection.",
      "ctx is the ProcessorContext callback parameter in the lowered defineProcessor wrapper. process(() => ...) becomes its process method.",
      "The Playground engine expects an output named main, so this complete example explicitly declares that output while using the automatically supplied input. No external-file imports or SIMD are available in this single-file runtime.",
    ],
    before: 'const out = audioOutput({ channels: 2, name: "main" });',
    after: [
      'const input = audioInput({ channels: 2, name: "input" });',
      "defineProcessor(ctx =>",
      "ctx.sampleRate",
    ],
    example: `const out = audioOutput({ channels: 2, name: "main" });
process(() => { forSample((i) => {
  out.left[i] = input.left[i];
  out.right[i] = f32(220 / ctx.sampleRate);
}); });`,
    reference: reference("lower.ts"),
  },
  {
    id: "unsupported",
    name: "Assignments and bitwise operators are not sugar",
    category: "Control flow",
    summary:
      "Scalar =, compound += / -= / *= / /= / %=, and bitwise & | ^ << >> do not become DSP operations.",
    details: [
      "Unsupported scalar write: env = value. Unsupported compound write: env += value. Use env.write(env + value).",
      "DSP bitwise expressions are not rewritten. Their JavaScript behavior is not valid DSP bit manipulation; do not use them on Nodes.",
      "Rejected DSP if: if (env > 0) { env.write(1); env.write(2); }. Only the documented single-target writes and emit-only blocks lower. Pure JavaScript-number arithmetic and JavaScript-boolean if remain build-time JavaScript.",
    ],
    before: "env.write(env + 0.001);",
    after: ["env.write(add(env.read(), 0.001));"],
    example: processor(
      "const env = state.f32(0);",
      "env.write(env + 0.001);\n    out.left[i] = env;\n    out.right[i] = env;",
    ),
    reference: reference("classify.ts"),
  },
];

export const unsupportedExamples: {
  name: string;
  source: string;
  error?: string;
  unchanged?: string;
}[] = [
  {
    name: "multi-write DSP if",
    source: processor("const env = state.f32(0);", "if (env > 0) { env.write(1); env.write(2); }"),
    error: "uwk-unsupported-if",
  },
  {
    name: "different-target DSP if",
    source: processor(
      "const a = state.f32(0);\nconst b = state.f32(0);",
      "if (a > 0) a.write(1); else b.write(2);",
    ),
    error: "uwk-unsupported-if",
  },
  {
    name: "scalar assignment",
    source: processor("let env = state.f32(0);", "env = f32(1);"),
    unchanged: "env = f32(1)",
  },
  {
    name: "compound assignment",
    source: processor("let env = state.f32(0);", "env += f32(1);"),
    unchanged: "env += f32(1)",
  },
  {
    name: "bitwise operators",
    source: processor("", "const result = i32(1) & i32(2);"),
    unchanged: "i32(1) & i32(2)",
  },
];
