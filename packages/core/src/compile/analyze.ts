/**
 * Static-analysis stage of the compile pipeline (= `03-compiler.md` §3、
 * plan Q-D stage 別 internal module の 1 つ目)。
 *
 * Layer 3 check 群 を kind ご と に 順 次 fill。 現 状 fill 済:
 *   - `constant-truthy-emitif` (Q32-c): `forSample` callback 内 で 構 文 上
 *     constant-truthy な `emitIf` cond は emit 前 に reject。
 *   - `select-branch-type-mismatch`: `select` の 2 branch が 異 な る scalar 型 =
 *     WASM `select` は 同 型 branch 必 須 = reject。 多 型 lowering 後 も branch 型
 *     不 一 致 (= TS をすり抜けた 場 合) を fail-loud で 弾 く。
 *
 * 算 術 / 比 較 は operand の scalar 型 を AST に 担 ぎ、 emit が 型 別 命 令 を
 * 出 す (= 多 型 lowering)。 旧 `non-f32-arithmetic` guard (= f32 固 定 emit 時 代 の
 * silent mis-compile 防 止) は 撤 去 済 み。
 */

import type { AstNode, CapturedGraph } from "./ast.ts";
import { inferAstType } from "./ast.ts";

export type DiagnosticEntry = {
  readonly id: string;
  readonly severity: "error" | "warning";
  readonly message: string;
};

/**
 * cond AST が build-time-constant な truthy 値 を 表 す か。 graph capture 時
 * の literal lift と zip し て、 literal で value !== 0 = truthy と 判 定。
 */
function isConstantTruthy(node: AstNode): boolean {
  return node.kind === "literal" && node.value !== 0;
}

function walkForConstantTruthyEmitIf(
  body: readonly AstNode[],
  diagnostics: DiagnosticEntry[],
): void {
  for (const node of body) {
    if (node.kind === "eventEmitIf" && isConstantTruthy(node.cond)) {
      diagnostics.push({
        id: "constant-truthy-emitif",
        severity: "error",
        message: `unworklet: event "${node.name}" emitIf has a constant-truthy cond inside forSample — unconditional emission at audio rate fills the ringbuffer in milliseconds. Use a state-edge gated cond, move the emission to a handler context, or wrap it in everyNSamples(N, ...) for sub-rate periodic emission (= Q32-c, stable ID 'constant-truthy-emitif')`,
      });
    }
    // MIDI emit shares the same ring (= `11-midi.md` §4): an `emitIf(true)` at
    // sample rate saturates the MIDI ringbuffer just as `event` does.
    if (node.kind === "midiEmitIf" && isConstantTruthy(node.cond)) {
      diagnostics.push({
        id: "constant-truthy-emitif",
        severity: "error",
        message: `unworklet: midi port "${node.port}" emitIf has a constant-truthy cond inside forSample — unconditional emission at audio rate fills the ringbuffer in milliseconds. Use a state-edge gated cond, move the emission to a handler context, or wrap it in everyNSamples(N, ...) for sub-rate periodic emission (= Q32-c, stable ID 'constant-truthy-emitif')`,
      });
    }
    if (node.kind === "forSample") {
      walkForConstantTruthyEmitIf(node.body, diagnostics);
    }
  }
}

/**
 * 全 node を walk し、 `select` の branch 型 不 一 致 を 検 出 (= `select-branch-type-mismatch`)。
 * literal branch は select builder が branch 型 へ lift 済 み (= Q33)、 ここ で 弾 く の は
 * TS を す り 抜 け た 真 の 型 不 一 致 (= `Node<'f32'>` と `Node<'i32'>` の 2 branch 等)。
 */
function walkForTypeErrors(node: AstNode, diagnostics: DiagnosticEntry[]): void {
  switch (node.kind) {
    case "mul":
    case "add":
    case "sub":
    case "div":
    case "mod":
    case "max":
    case "min":
    case "eq":
    case "lt":
    case "gt":
    case "lte":
    case "gte":
      walkForTypeErrors(node.lhs, diagnostics);
      walkForTypeErrors(node.rhs, diagnostics);
      break;
    case "abs":
    case "neg":
    case "sqrt":
    case "floor":
    case "ceil":
    case "frac":
    case "sin":
    case "cos":
    case "tan":
    case "exp":
    case "log":
    case "tanh":
    case "convert":
      walkForTypeErrors(node.value, diagnostics);
      break;
    case "clamp":
      walkForTypeErrors(node.x, diagnostics);
      walkForTypeErrors(node.lo, diagnostics);
      walkForTypeErrors(node.hi, diagnostics);
      break;
    case "select": {
      const thenType = inferAstType(node.ifTrue);
      const elseType = inferAstType(node.ifFalse);
      if (thenType !== elseType) {
        diagnostics.push({
          id: "select-branch-type-mismatch",
          severity: "error",
          message: `unworklet: select branches have mismatched scalar types ('${thenType}' vs '${elseType}') — WASM select requires both branches to be the same type. (stable ID 'select-branch-type-mismatch')`,
        });
      }
      walkForTypeErrors(node.cond, diagnostics);
      walkForTypeErrors(node.ifTrue, diagnostics);
      walkForTypeErrors(node.ifFalse, diagnostics);
      break;
    }
    case "audioInRead":
    case "paramAt":
      walkForTypeErrors(node.offset, diagnostics);
      break;
    case "audioOutWrite":
      walkForTypeErrors(node.offset, diagnostics);
      walkForTypeErrors(node.value, diagnostics);
      break;
    case "stateStore":
      walkForTypeErrors(node.value, diagnostics);
      break;
    case "bufferRead":
      walkForTypeErrors(node.index, diagnostics);
      break;
    case "bufferReadInterpolated":
      walkForTypeErrors(node.pos, diagnostics);
      break;
    case "payloadFieldRead":
      walkForTypeErrors(node.index, diagnostics);
      break;
    case "payloadFieldLength":
      break;
    case "bufferCopyFrom":
      // 子 expression ナ シ (= bufferName / messageName / field は string)。
      break;
    case "bufferWrite":
      walkForTypeErrors(node.index, diagnostics);
      walkForTypeErrors(node.value, diagnostics);
      break;
    case "forSample":
    case "messageOnReceive":
    case "everyNSamples":
      for (const child of node.body) walkForTypeErrors(child, diagnostics);
      break;
    case "eventEmitIf":
      walkForTypeErrors(node.cond, diagnostics);
      walkForTypeErrors(node.atSample, diagnostics);
      for (const field of node.fields) {
        walkForTypeErrors(field.value, diagnostics);
        if (field.length !== undefined) walkForTypeErrors(field.length, diagnostics);
      }
      break;
    case "vecConst":
      for (const l of node.lanes) walkForTypeErrors(l, diagnostics);
      break;
    case "vecSplat":
    case "vecLane":
    case "vecSumLanes":
      walkForTypeErrors(node.value, diagnostics);
      break;
    case "vecAdd":
    case "vecSub":
    case "vecMul":
    case "vecDiv":
      walkForTypeErrors(node.lhs, diagnostics);
      walkForTypeErrors(node.rhs, diagnostics);
      break;
    case "bufferLoadVec":
      walkForTypeErrors(node.offset, diagnostics);
      break;
    case "bufferStoreVec":
      walkForTypeErrors(node.offset, diagnostics);
      walkForTypeErrors(node.value, diagnostics);
      break;
    case "literal":
    case "loopCounter":
    case "stateLoad":
    case "messageFieldRead":
      break;
  }
}

// forSample.byN(stride) で許可する stride = 1 ブロック (128) を割り切る 2 の冪。
// SIMD bulk (stride 4 で 4 sample load) 等で 128 / stride が整数になる必要がある。
const ALLOWED_STRIDES = new Set([1, 2, 4, 8, 16, 32, 64, 128]);

// loop primitive (forSample.byN / everyNSamples) の compile-time 静的検証。
// forSample.byN stride は 128 を割り切る 2 の冪 (= ALLOWED_STRIDES)、everyNSamples
// の divisor N は §9.5 で「compile-time な正の整数」(= block 跨ぎ free-running counter
// なので 128 を割り切る必要はない、§9.1)。どちらも違反は audio thread に届く前に reject:
// N=0 は emit が i32.rem_u(counter, 0) を吐いて audio thread で 0 除算 trap する。
function walkForLoopErrors(body: readonly AstNode[], diagnostics: DiagnosticEntry[]): void {
  for (const node of body) {
    if (node.kind === "forSample") {
      if (!ALLOWED_STRIDES.has(node.stride)) {
        diagnostics.push({
          id: "illegal-stride",
          severity: "error",
          message: `unworklet: forSample.byN stride ${node.stride} は render quantum (128) を割り切る 2 の冪ではない。許可: 1, 2, 4, 8, 16, 32, 64, 128 (stable ID 'illegal-stride')`,
        });
      }
      walkForLoopErrors(node.body, diagnostics);
    } else if (node.kind === "everyNSamples") {
      if (!Number.isInteger(node.divisor) || node.divisor < 1) {
        diagnostics.push({
          id: "illegal-everyn-divisor",
          severity: "error",
          message: `unworklet: everyNSamples(N) の N は compile-time な正の整数でなければならない (got ${node.divisor})。N=0 は audio thread で 0 除算 trap、負/非整数は無効 (stable ID 'illegal-everyn-divisor')`,
        });
      }
      walkForLoopErrors(node.body, diagnostics);
    }
  }
}

// §5.1: message<T> / event<T> の payload は variable-length (typed-array) field を
// 1 つまで。slot は単一の [payloadLen, payloadOffset] pair しか持てないので、複数あると
// transport が破綻する → graph-capture-time error。field は access (.at() / copyFrom /
// emitIf) 時に payloadElementType が seal されるので、seal 済を数えて 2 つ以上で reject。
function checkPayloadFieldLimit(graph: CapturedGraph, diagnostics: DiagnosticEntry[]): void {
  for (const decl of graph.declarations) {
    if (decl.kind !== "message" && decl.kind !== "event") continue;
    const taFields = decl.fields.filter((f) => f.payloadElementType !== undefined);
    if (taFields.length > 1) {
      diagnostics.push({
        id: "multiple-typed-array-fields",
        severity: "error",
        message:
          `unworklet: ${decl.kind} "${decl.name}" payload has ${taFields.length} variable-length ` +
          `(typed-array) fields (${taFields.map((f) => f.name).join(", ")}). v1.0.0 allows at most ` +
          `one variable-length field per payload (§5.1). (stable ID 'multiple-typed-array-fields')`,
      });
    }
  }
}

/** 64 MiB — low-end-device load-time concern (warning). */
const MEMORY_WARN_BYTES = 64 * 1024 * 1024;
/** 4 GiB — the WASM 32-bit linear-memory ceiling (hard error). */
const MEMORY_ERROR_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * Memory-budget check (Q30, `03-compiler.md` §2.6 stable ID `memory-budget`).
 * The compiler auto-sums every declaration into a single linear-memory
 * allocation; `memory.grow` on the audio thread is permanently excluded. A
 * total above 64 MiB emits a build-time warning (load-time concern), above the
 * 4 GiB WASM32 ceiling a hard error. Takes the laid-out `totalBytes` since the
 * sum is only known after `layout`.
 */
export function checkMemoryBudget(totalBytes: number): DiagnosticEntry[] {
  if (totalBytes > MEMORY_ERROR_BYTES) {
    return [
      {
        id: "memory-budget",
        severity: "error",
        message:
          `unworklet: declaration memory sum (${totalBytes} bytes) exceeds the WASM 32-bit ` +
          `linear-memory ceiling of 4 GiB. Reduce buffer sizes or move large content to a ` +
          `message<T> upload pattern. (stable ID 'memory-budget')`,
      },
    ];
  }
  if (totalBytes > MEMORY_WARN_BYTES) {
    return [
      {
        id: "memory-budget",
        severity: "warning",
        message:
          `unworklet: declaration memory sum (${totalBytes} bytes) exceeds 64 MiB — this loads ` +
          `slowly on low-end devices. Consider reducing buffer sizes. (stable ID 'memory-budget')`,
      },
    ];
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────
// handler-field-escape: a `message<T>` onReceive payload field (or a MIDI
// onEvent field) decodes the *current drain slot* and is only valid inside the
// handler body that drains it. Capturing such a field Node and reading it
// elsewhere (a forSample, the per-block top level, another handler) makes emit
// read an unset slot pointer = a silent 0 / garbage value. Detect statically.
// ─────────────────────────────────────────────────────────────────────────

type HandlerScope = { kind: "message"; name: string } | { kind: "midi"; port?: string } | null;

// Every AstNode-valued child field except `body` (bodies carry handler scope and
// are walked explicitly). Field-name based, so a new node kind is covered without
// re-listing variants; a missed field only weakens detection, never flags valid code.
const EXPR_CHILD_FIELDS = [
  "lhs",
  "rhs",
  "value",
  "x",
  "lo",
  "hi",
  "cond",
  "ifTrue",
  "ifFalse",
  "offset",
  "index",
  "pos",
  "atSample",
  "channel",
  "arg1",
  "arg2",
  "sysexLength",
] as const;

function exprChildren(node: AstNode): AstNode[] {
  const n = node as Record<string, unknown>;
  const out: AstNode[] = [];
  const push = (v: unknown): void => {
    if (v !== null && typeof v === "object" && "kind" in v) out.push(v as AstNode);
  };
  for (const f of EXPR_CHILD_FIELDS) push(n[f]);
  if (Array.isArray(n["lanes"])) for (const l of n["lanes"]) push(l);
  if (Array.isArray(n["fields"])) {
    for (const field of n["fields"] as Array<Record<string, unknown>>) {
      push(field["value"]);
      push(field["length"]);
    }
  }
  return out;
}

function checkHandlerFieldEscape(
  node: AstNode,
  scope: HandlerScope,
  diagnostics: DiagnosticEntry[],
): void {
  let want: "message" | "midi";
  let wantName: string | undefined;
  let label: string;
  switch (node.kind) {
    case "messageFieldRead":
      want = "message";
      wantName = node.name;
      label = `message "${node.name}" field "${node.field}"`;
      break;
    case "payloadFieldRead":
    case "payloadFieldLength":
      want = "message";
      wantName = node.messageName;
      label = `message "${node.messageName}" field "${node.field}"`;
      break;
    case "bufferCopyFrom":
      want = "message";
      wantName = node.messageName;
      label = `message "${node.messageName}" field "${node.field}"`;
      break;
    case "midiFieldRead":
      want = "midi";
      wantName = undefined;
      label = `midi field "${node.field}"`;
      break;
    case "midiSysexLength":
    case "midiSysexCopy":
      want = "midi";
      wantName = node.port;
      label = `midi port "${node.port}" sysex`;
      break;
    default:
      return;
  }
  const ok =
    want === "midi"
      ? scope !== null &&
        scope.kind === "midi" &&
        (wantName === undefined || scope.port === wantName)
      : scope !== null && scope.kind === "message" && scope.name === wantName;
  if (!ok) {
    diagnostics.push({
      id: "handler-field-escape",
      severity: "error",
      message:
        `unworklet: ${label} is read outside its handler. Handler payload fields decode the ` +
        `current drain slot and are only valid inside the on-receive / on-event body — a field ` +
        `Node captured and read elsewhere reads an unset slot (= silent 0). Move the read into ` +
        `the handler, or copy the value into a state / buffer first. (stable ID 'handler-field-escape')`,
    });
  }
}

function walkHandlerFieldEscape(
  nodes: readonly AstNode[],
  scope: HandlerScope,
  diagnostics: DiagnosticEntry[],
): void {
  for (const node of nodes) {
    checkHandlerFieldEscape(node, scope, diagnostics);
    walkHandlerFieldEscape(exprChildren(node), scope, diagnostics);
    if (node.kind === "messageOnReceive") {
      walkHandlerFieldEscape(node.body, { kind: "message", name: node.name }, diagnostics);
    } else if (node.kind === "midiOnEvent") {
      walkHandlerFieldEscape(node.body, { kind: "midi", port: node.port }, diagnostics);
    } else if (node.kind === "forSample" || node.kind === "everyNSamples") {
      walkHandlerFieldEscape(node.body, scope, diagnostics);
    }
  }
}

export function analyze(graph: CapturedGraph): DiagnosticEntry[] {
  const diagnostics: DiagnosticEntry[] = [];
  walkForLoopErrors(graph.statements, diagnostics);
  checkPayloadFieldLimit(graph, diagnostics);
  walkHandlerFieldEscape(graph.statements, null, diagnostics);
  for (const stmt of graph.statements) {
    if (stmt.kind === "forSample") {
      walkForConstantTruthyEmitIf(stmt.body, diagnostics);
    }
    walkForTypeErrors(stmt, diagnostics);
  }
  return diagnostics;
}
