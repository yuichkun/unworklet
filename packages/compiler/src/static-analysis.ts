// Static analysis pass over a captured graph. Runs before WASM emission.
//
// Per docs/03-compiler.md §3 and draft_spec §7.2, the analysis verifies the
// invariants the framework promises ("realtime-safe by construction") AND
// reports compile-time warnings on patterns that are legal but expensive or
// suggest a bug (unused parameters, unprotected feedback paths, etc.).
//
// Levels:
//   - error: invariant violation; compilation should fail.
//   - warning: legal but flagged for the user.
//   - info: informational metric (e.g. instruction count).

import type {
  ASTValue,
  CapturedGraph,
  Statement,
} from "./ast.js";
import type { MemoryLayout } from "./memory-layout.js";

export type Diagnostic = {
  level: "error" | "warning" | "info";
  code: string;
  message: string;
  refactorHint?: string;
};

export type AnalysisResult = {
  diagnostics: Diagnostic[];
  metrics: {
    statesDeclared: number;
    buffersDeclared: number;
    paramsDeclared: number;
    audioInputs: number;
    audioOutputs: number;
    eventsDeclared: number;
    messagesDeclared: number;
    midiInputs: number;
    midiOutputs: number;
    forSampleBlocks: number;
    everyNSamplesBlocks: number;
    estInstructionsPerBlock: number;
    estInstructionsPerSample: number;
    memoryBytes: number;
    memoryPages: number;
  };
};

const ERROR_BUDGET_MEMORY_BYTES = 64 * 1024 * 1024; // 64 MiB default cap

const OP_WEIGHTS: Record<string, number> = {
  add: 1, sub: 1, mul: 1, div: 4, mod: 4, neg: 1, min: 1, max: 1, abs: 1, clamp: 2,
  eq: 1, ne: 1, lt: 1, gt: 1, lte: 1, gte: 1,
  sin: 20, cos: 20, tan: 25, tanh: 25, exp: 20, log: 20, sqrt: 4, floor: 2, ceil: 2, frac: 2,
  select: 2,
  "state-load": 2, "state-store": 2,
  "buffer-read": 3, "buffer-write": 3, "buffer-read-interp": 6, "buffer-load-vec": 4, "buffer-store-vec": 4,
  "audio-in-at": 2, "audio-out-set": 2, "param-at": 2,
  "vec-ctor": 4, "vec-splat": 1, "vec-lane": 1, "vec-arith": 1,
  convert: 1, const: 0, "instance-const": 0, "loop-var": 0, "message-field": 2, "midi-field": 2,
  "message-var-len": 0, "message-var-read": 3,
  "emit-if": 6, "midi-emit-if": 6,
};

function valueWeight(v: ASTValue): number {
  let w = OP_WEIGHTS[v.kind] ?? 1;
  // Recurse over operands
  switch (v.kind) {
    case "arith": for (const a of v.args) w += valueWeight(a); break;
    case "compare": w += valueWeight(v.a) + valueWeight(v.b); break;
    case "logic": for (const a of v.args) w += valueWeight(a); break;
    case "math": w += valueWeight(v.arg); break;
    case "select": w += valueWeight(v.cond) + valueWeight(v.whenTrue) + valueWeight(v.whenFalse); break;
    case "convert": w += valueWeight(v.arg); break;
    case "buffer-read": w += valueWeight(v.idx); break;
    case "buffer-read-interp": w += valueWeight(v.pos); break;
    case "buffer-load-vec": w += valueWeight(v.offset); break;
    case "audio-in-at": w += valueWeight(v.i); break;
    case "param-at": w += valueWeight(v.i); break;
    case "vec-ctor": for (const a of v.lanes) w += valueWeight(a); break;
    case "vec-splat": w += valueWeight(v.arg); break;
    case "vec-lane": w += valueWeight(v.vec); break;
    case "vec-arith": w += valueWeight(v.a) + valueWeight(v.b); break;
  }
  return w;
}

function statementWeight(s: Statement, renderQuantum: number): { perBlock: number; perSample: number } {
  switch (s.kind) {
    case "state-store": return { perBlock: OP_WEIGHTS["state-store"]! + valueWeight(s.value), perSample: 0 };
    case "buffer-write": return { perBlock: OP_WEIGHTS["buffer-write"]! + valueWeight(s.idx) + valueWeight(s.value), perSample: 0 };
    case "buffer-store-vec": return { perBlock: OP_WEIGHTS["buffer-store-vec"]! + valueWeight(s.offset) + valueWeight(s.value), perSample: 0 };
    case "audio-out-set": return { perBlock: OP_WEIGHTS["audio-out-set"]! + valueWeight(s.i) + valueWeight(s.value), perSample: 0 };
    case "emit-if": {
      let w = OP_WEIGHTS["emit-if"]! + valueWeight(s.cond) + valueWeight(s.atSample);
      for (const f of s.fields) w += valueWeight(f.value);
      return { perBlock: w, perSample: 0 };
    }
    case "midi-emit-if":
      return { perBlock: OP_WEIGHTS["midi-emit-if"]! + valueWeight(s.cond) + valueWeight(s.status) + valueWeight(s.data1) + valueWeight(s.data2) + valueWeight(s.atSample), perSample: 0 };
    case "for-sample": {
      let perSample = 0;
      for (const inner of s.body) {
        const w = statementWeight(inner, renderQuantum);
        perSample += w.perBlock + w.perSample;
      }
      const iterations = renderQuantum / s.stride;
      return { perBlock: perSample * iterations, perSample };
    }
    case "every-n-samples": {
      let bodyW = 0;
      for (const inner of s.body) {
        const w = statementWeight(inner, renderQuantum);
        bodyW += w.perBlock + w.perSample;
      }
      // Average cost: bodyW × (1/N)
      return { perBlock: bodyW / s.N, perSample: 0 };
    }
  }
}

export function analyze(
  graph: CapturedGraph,
  layout: MemoryLayout,
  options: { memoryBudgetBytes?: number } = {},
): AnalysisResult {
  const memBudget = options.memoryBudgetBytes ?? ERROR_BUDGET_MEMORY_BYTES;
  const diags: Diagnostic[] = [];
  const decls = graph.declarations;

  // Collect per-statement weights
  let perBlockTotal = 0;
  let perSampleTotal = 0;
  let forSampleBlocks = 0;
  let everyNBlocks = 0;
  function walk(stmts: Statement[]) {
    for (const s of stmts) {
      if (s.kind === "for-sample") {
        forSampleBlocks++;
        for (const inner of s.body) {
          if (inner.kind === "every-n-samples") everyNBlocks++;
        }
      }
      const w = statementWeight(s, layout.renderQuantum);
      perBlockTotal += w.perBlock;
      perSampleTotal += w.perSample;
    }
  }
  walk(graph.processBody);
  for (const h of graph.messageHandlers) {
    for (const s of h.body) walk([s]);
  }
  for (const h of graph.midiHandlers) {
    for (const s of h.body) walk([s]);
  }

  // ─── Memory budget check ──────────────────────────────────────────────
  if (layout.totalBytes > memBudget) {
    diags.push({
      level: "error",
      code: "memory-budget-exceeded",
      message: `Total linear memory (${layout.totalBytes} bytes) exceeds budget (${memBudget} bytes).`,
      refactorHint: `Reduce buffer sizes or increase memoryBudgetBytes in compile options.`,
    });
  }

  // ─── Required-call: every audioOutput must be written somewhere ───────
  const writtenOutputs = new Set<string>();
  function findAudioOutSet(stmts: Statement[]) {
    for (const s of stmts) {
      if (s.kind === "audio-out-set") writtenOutputs.add(`${s.outputId}:${s.channel}`);
      else if (s.kind === "for-sample") findAudioOutSet(s.body);
      else if (s.kind === "every-n-samples") findAudioOutSet(s.body);
    }
  }
  findAudioOutSet(graph.processBody);
  for (const ao of decls.audioOutputs) {
    for (let c = 0; c < ao.channels; c++) {
      if (!writtenOutputs.has(`${ao.id}:${c}`)) {
        diags.push({
          level: "error",
          code: "audio-output-not-written",
          message: `audioOutput "${ao.name}" channel ${c} is never written.`,
          refactorHint: `Add a forSample callback that calls ${ao.name}.set(${c}, i, ...) for every sample of the render quantum.`,
        });
      }
    }
  }

  // ─── Parameter reachability: warn on declared but unused params ───────
  const referencedParams = new Set<number>();
  function visitVal(v: ASTValue) {
    switch (v.kind) {
      case "param-at": referencedParams.add(v.paramId); break;
      case "arith": for (const a of v.args) visitVal(a); break;
      case "compare": visitVal(v.a); visitVal(v.b); break;
      case "logic": for (const a of v.args) visitVal(a); break;
      case "math": visitVal(v.arg); break;
      case "select": visitVal(v.cond); visitVal(v.whenTrue); visitVal(v.whenFalse); break;
      case "convert": visitVal(v.arg); break;
      case "buffer-read": visitVal(v.idx); break;
      case "buffer-read-interp": visitVal(v.pos); break;
      case "buffer-load-vec": visitVal(v.offset); break;
      case "audio-in-at": visitVal(v.i); break;
      case "vec-ctor": for (const a of v.lanes) visitVal(a); break;
      case "vec-splat": visitVal(v.arg); break;
      case "vec-lane": visitVal(v.vec); break;
      case "vec-arith": visitVal(v.a); visitVal(v.b); break;
    }
  }
  function visitStmt(s: Statement) {
    switch (s.kind) {
      case "state-store": visitVal(s.value); break;
      case "buffer-write": visitVal(s.idx); visitVal(s.value); break;
      case "buffer-store-vec": visitVal(s.offset); visitVal(s.value); break;
      case "audio-out-set": visitVal(s.i); visitVal(s.value); break;
      case "emit-if": visitVal(s.cond); visitVal(s.atSample); for (const f of s.fields) visitVal(f.value); break;
      case "midi-emit-if": visitVal(s.cond); visitVal(s.status); visitVal(s.data1); visitVal(s.data2); visitVal(s.atSample); break;
      case "for-sample": for (const inner of s.body) visitStmt(inner); break;
      case "every-n-samples": for (const inner of s.body) visitStmt(inner); break;
    }
  }
  for (const s of graph.processBody) visitStmt(s);
  for (const h of graph.messageHandlers) for (const s of h.body) visitStmt(s);
  for (const h of graph.midiHandlers) for (const s of h.body) visitStmt(s);
  for (const p of decls.params) {
    if (!referencedParams.has(p.id)) {
      diags.push({
        level: "warning",
        code: "param-unused",
        message: `Parameter "${p.name}" is declared but never read inside the process body.`,
        refactorHint: `If the parameter is intentional but unused at the moment, prefix the name with '_' or remove the declaration. If unintentional, ensure ${p.name}.at(i) is called in the per-sample body.`,
      });
    }
  }

  // ─── Cycle estimate informational ─────────────────────────────────────
  const sr = 48000; // representative
  diags.push({
    level: "info",
    code: "cycle-estimate",
    message: `Estimated ~${perBlockTotal.toFixed(0)} ops/block (~${(perBlockTotal * sr / layout.renderQuantum).toFixed(0)} ops/s @ ${sr} Hz).`,
  });

  return {
    diagnostics: diags,
    metrics: {
      statesDeclared: decls.states.length,
      buffersDeclared: decls.buffers.length,
      paramsDeclared: decls.params.length,
      audioInputs: decls.audioInputs.length,
      audioOutputs: decls.audioOutputs.length,
      eventsDeclared: decls.events.length,
      messagesDeclared: decls.messages.length,
      midiInputs: decls.midiInputs.length,
      midiOutputs: decls.midiOutputs.length,
      forSampleBlocks,
      everyNSamplesBlocks: everyNBlocks,
      estInstructionsPerBlock: Math.round(perBlockTotal),
      estInstructionsPerSample: Math.round(perBlockTotal / layout.renderQuantum),
      memoryBytes: layout.totalBytes,
      memoryPages: layout.initialPages,
    },
  };
}

export function formatDiagnostic(d: Diagnostic): string {
  const head = `${d.level.toUpperCase()} [${d.code}] ${d.message}`;
  if (!d.refactorHint) return head;
  return `${head}\n  hint: ${d.refactorHint}`;
}
