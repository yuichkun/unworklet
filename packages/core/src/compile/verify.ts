/**
 * Layer A — static realtime-safety proof over the emitted WASM.
 *
 * The audio path (the `process` function + the shared math helpers) runs inside
 * `AudioWorkletGlobalScope` under a hard ~2.67 ms deadline. It must be
 * allocation-free (no `memory.grow` — a grow is a real allocation that can
 * trigger GC and a dropout), it must not contain an unbounded loop (a hang
 * starves every subsequent quantum), and it must not contain a deliberate trap
 * (`unreachable`) that would latch the processor to permanent silence.
 *
 * This walks the binaryen IR in-process, BEFORE `emitBinary()`, and proves those
 * properties over every function the module ships. `compile()` fails on any
 * violation, so a binary that is not realtime-safe by construction can never be
 * produced. The walk is **fail-closed**: a node whose shape this verifier does
 * not understand is itself a violation (`unhandled-node`), so a future emitter
 * change cannot smuggle an un-traversed subtree past the proof — the test suite
 * pins that the real emitter output is fully traversed.
 *
 * ## Honest limits
 *
 * - "No unbounded loop" is proved as a sound *necessary* condition: every `loop`
 *   must contain a conditional break (a `br_if` that can exit it). A loop with
 *   no conditional exit is provably infinite and rejected; the emitter's counted
 *   loops all carry one. A full trip-count proof is out of scope.
 * - Trap-freedom from out-of-range *memory indexing* (a user `buffer[i]`) is
 *   enforced at the emitter (the index is clamped) and checked behaviorally
 *   (Layer C/E), not here — a sound static in-bounds proof over arbitrary index
 *   expressions is not tractable, and a fragile one would be theater.
 */

import type { BinaryenAPI, BinaryenModule } from "./emit.ts";

export type VerifyRule =
  | "memory-not-fixed"
  | "memory-grow"
  | "memory-init"
  | "unreachable"
  | "unbounded-loop"
  | "unhandled-node";

export interface VerifyViolation {
  readonly rule: VerifyRule;
  /** The function the violation was found in, or "(module)" for module-level. */
  readonly fn: string;
  readonly detail: string;
}

/** An ExpressionRef is an opaque pointer (a number) into the binaryen heap. */
type ExpressionRef = number;

/**
 * A structural view over `getExpressionInfo`'s union return. Every field is one
 * the binaryen `*Info` interfaces declare; only the ones present for a given
 * `id` are set, so each accessor below reads exactly what that node carries.
 */
interface ExprInfo {
  readonly id: number;
  readonly children?: ExpressionRef[];
  readonly body?: ExpressionRef;
  readonly condition?: ExpressionRef;
  readonly ifTrue?: ExpressionRef;
  readonly ifFalse?: ExpressionRef;
  readonly left?: ExpressionRef;
  readonly right?: ExpressionRef;
  readonly value?: ExpressionRef;
  readonly ptr?: ExpressionRef;
  readonly delta?: ExpressionRef;
  readonly dest?: ExpressionRef;
  readonly source?: ExpressionRef;
  readonly size?: ExpressionRef;
  readonly offset?: ExpressionRef;
  readonly target?: ExpressionRef;
  readonly expected?: ExpressionRef;
  readonly replacement?: ExpressionRef;
  readonly vec?: ExpressionRef;
  readonly shift?: ExpressionRef;
  readonly a?: ExpressionRef;
  readonly b?: ExpressionRef;
  readonly c?: ExpressionRef;
  readonly operands?: ExpressionRef[];
}

/** Is `id` a leaf node (no ExpressionRef children)? */
function isLeaf(id: number, bin: BinaryenAPI): boolean {
  return (
    id === bin.ConstId ||
    id === bin.LocalGetId ||
    id === bin.GlobalGetId ||
    id === bin.NopId ||
    id === bin.UnreachableId ||
    id === bin.PopId ||
    id === bin.MemorySizeId ||
    id === bin.DataDropId ||
    id === bin.RefNullId ||
    id === bin.RefFuncId
  );
}

/**
 * Non-null ExpressionRef children, or `null` if the node id is unhandled. Only
 * called for non-leaf nodes — binaryen's `getExpressionInfo` throws on a bare
 * `nop` / `unreachable`, so leaves are resolved by id alone (see `walk`).
 */
function childrenOf(expr: ExpressionRef, id: number, bin: BinaryenAPI): ExpressionRef[] | null {
  const present = (...refs: Array<ExpressionRef | undefined>): ExpressionRef[] =>
    refs.filter((r): r is ExpressionRef => r !== undefined && r !== 0);
  const info = bin.getExpressionInfo(expr) as ExprInfo;
  switch (id) {
    // ── control flow ──
    case bin.BlockId:
      return info.children ?? [];
    case bin.IfId:
      return present(info.condition, info.ifTrue, info.ifFalse);
    case bin.LoopId:
      return present(info.body);
    case bin.BreakId:
      return present(info.condition, info.value);
    case bin.SwitchId:
      return present(info.condition, info.value);
    case bin.ReturnId:
      return present(info.value);
    // ── calls ──
    case bin.CallId:
      return info.operands ?? [];
    case bin.CallIndirectId:
      return present(info.target).concat(info.operands ?? []);
    // ── locals / globals ──
    case bin.LocalSetId:
    case bin.GlobalSetId:
      return present(info.value);
    // ── memory ──
    case bin.LoadId:
      return present(info.ptr);
    case bin.StoreId:
      return present(info.ptr, info.value);
    case bin.MemoryGrowId:
      return present(info.delta);
    case bin.MemoryInitId:
      return present(info.dest, info.offset, info.size);
    case bin.MemoryCopyId:
      return present(info.dest, info.source, info.size);
    case bin.MemoryFillId:
      return present(info.dest, info.value, info.size);
    case bin.AtomicRMWId:
      return present(info.ptr, info.value);
    case bin.AtomicCmpxchgId:
      return present(info.ptr, info.expected, info.replacement);
    // ── arithmetic ──
    case bin.UnaryId:
      return present(info.value);
    case bin.BinaryId:
      return present(info.left, info.right);
    case bin.SelectId:
      return present(info.condition, info.ifTrue, info.ifFalse);
    case bin.DropId:
      return present(info.value);
    // ── SIMD (used by the vector math path) ──
    case bin.SIMDExtractId:
      return present(info.vec);
    case bin.SIMDReplaceId:
      return present(info.vec, info.value);
    case bin.SIMDShuffleId:
      return present(info.left, info.right);
    case bin.SIMDTernaryId:
      return present(info.a, info.b, info.c);
    case bin.SIMDShiftId:
      return present(info.vec, info.shift);
    case bin.SIMDLoadId:
      return present(info.ptr);
    case bin.SIMDLoadStoreLaneId:
      return present(info.ptr, info.vec);
    default:
      return null; // unhandled — fail-closed (recorded as a violation)
  }
}

/** Does the loop body carry a conditional break that can exit it? */
function loopHasConditionalExit(body: ExpressionRef, bin: BinaryenAPI): boolean {
  let found = false;
  const scan = (expr: ExpressionRef): void => {
    if (found || expr === 0) return;
    const id = bin.getExpressionId(expr);
    if (id === bin.LoopId) return; // a nested loop's break exits the inner loop
    if (id === bin.BreakId) {
      const info = bin.getExpressionInfo(expr) as ExprInfo;
      if (info.condition !== undefined && info.condition !== 0) {
        found = true;
        return;
      }
    }
    if (isLeaf(id, bin)) return;
    const kids = childrenOf(expr, id, bin);
    if (kids === null) return;
    for (const k of kids) scan(k);
  };
  scan(body);
  return found;
}

function walk(expr: ExpressionRef, fnName: string, bin: BinaryenAPI, out: VerifyViolation[]): void {
  if (expr === 0) return; // a null/absent child (e.g. an empty function body)
  // Resolve the id cheaply: getExpressionInfo throws on a bare nop / unreachable.
  const id = bin.getExpressionId(expr);
  if (id === bin.MemoryGrowId) {
    out.push({
      rule: "memory-grow",
      fn: fnName,
      detail: "memory.grow allocates on the audio thread",
    });
  } else if (id === bin.MemoryInitId) {
    out.push({ rule: "memory-init", fn: fnName, detail: "memory.init" });
  } else if (id === bin.UnreachableId) {
    out.push({ rule: "unreachable", fn: fnName, detail: "deliberate trap latches silence" });
  } else if (id === bin.LoopId) {
    const info = bin.getExpressionInfo(expr) as ExprInfo;
    if (info.body !== undefined && !loopHasConditionalExit(info.body, bin)) {
      out.push({ rule: "unbounded-loop", fn: fnName, detail: "loop has no conditional exit" });
    }
  }
  if (isLeaf(id, bin)) return;
  const kids = childrenOf(expr, id, bin);
  if (kids === null) {
    out.push({ rule: "unhandled-node", fn: fnName, detail: `expression id ${id} not traversed` });
    return;
  }
  for (const k of kids) walk(k, fnName, bin, out);
}

/**
 * Prove the module's audio path is realtime-safe by construction. Returns every
 * violation found (empty = proved safe). Walks every function the module ships.
 */
export function verifyRealtimeSafe(mod: BinaryenModule, bin: BinaryenAPI): VerifyViolation[] {
  const out: VerifyViolation[] = [];

  // Memory must be fixed (initial == max): a growable memory is an allocation
  // the audio thread could trigger. The emitter sets `setMemory(pages, pages)`.
  if (mod.hasMemory()) {
    const mem = mod.getMemoryInfo();
    if (mem.max === undefined || mem.max !== mem.initial) {
      out.push({
        rule: "memory-not-fixed",
        fn: "(module)",
        detail: `initial=${mem.initial} max=${mem.max ?? "unbounded"}`,
      });
    }
  }

  for (let i = 0; i < mod.getNumFunctions(); i++) {
    const fn = mod.getFunctionByIndex(i);
    const info = bin.getFunctionInfo(fn);
    walk(info.body, info.name, bin, out);
  }
  return out;
}

/** Format violations into a single `compile()` error message. */
export function formatVerifyViolations(violations: readonly VerifyViolation[]): string {
  const lines = violations.map((v) => `  - [${v.rule}] ${v.fn}: ${v.detail}`);
  return `unworklet: the emitted audio-thread WASM is not realtime-safe:\n${lines.join("\n")}`;
}
