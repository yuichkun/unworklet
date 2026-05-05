// Structured errors per docs/03-compiler.md §2.4 / draft_spec §12.1.
//
// Three layers, ordered by detection time (earliest is preferred):
//   Layer 1 — TypeScript type errors (IDE; before any build)
//   Layer 2 — Graph capture errors (this module)
//   Layer 3 — Static analysis errors (static-analysis.ts)
//
// All Layer 2/3 errors carry a code, a human message, an optional refactor
// hint, and an optional source location.

export type ErrorLayer = 1 | 2 | 3;

export type StructuredError = {
  layer: ErrorLayer;
  code: string;
  message: string;
  refactorHint?: string;
  loc?: { file?: string; line?: number; col?: number };
};

export class UnworkletCompileError extends Error {
  layer: ErrorLayer;
  code: string;
  refactorHint?: string;
  loc?: { file?: string; line?: number; col?: number };

  constructor(err: StructuredError) {
    const head = `[unworklet ${layerName(err.layer)}/${err.code}] ${err.message}`;
    const full = err.refactorHint
      ? `${head}\n  hint: ${err.refactorHint}`
      : head;
    super(full);
    this.name = "UnworkletCompileError";
    this.layer = err.layer;
    this.code = err.code;
    this.refactorHint = err.refactorHint;
    this.loc = err.loc;
  }
}

function layerName(l: ErrorLayer): string {
  return l === 1 ? "L1-TS" : l === 2 ? "L2-capture" : "L3-analysis";
}

// ─── Layer 2 helpers ────────────────────────────────────────────────────────

export function captureError(
  code: string,
  message: string,
  refactorHint?: string,
): never {
  throw new UnworkletCompileError({
    layer: 2,
    code,
    message,
    refactorHint,
  });
}

// Common Layer 2 errors with canned refactor hints
export const L2 = {
  declarationOutsideScope(decl: string): never {
    throw new UnworkletCompileError({
      layer: 2,
      code: "decl-outside-scope",
      message: `${decl} declaration is only allowed in declaration scope (top of defineProcessor body, before the returned process lambda).`,
      refactorHint: `Move the ${decl} call to the top of the body, OR if the declaration depends on a per-sample value, refactor as a defineSubgraph (see docs/01-dsl.md §5.6).`,
    });
  },
  forSampleStrideNotConst(): never {
    throw new UnworkletCompileError({
      layer: 2,
      code: "forSample-byN-non-const-stride",
      message: `forSample.byN's stride must be a compile-time positive integer.`,
      refactorHint: `Pass a literal like 4, not a value computed from a Node<T>.`,
    });
  },
  duplicateOutputWrite(channel: number, outputName: string): never {
    throw new UnworkletCompileError({
      layer: 2,
      code: "duplicate-output-write",
      message: `audioOutput "${outputName}" channel ${channel} is written twice in the same phase.`,
      refactorHint: `Combine the two writes into a single set(c, i, ...) — use select(...) or arithmetic to compute the final value.`,
    });
  },
  laneIndexNotConst(): never {
    throw new UnworkletCompileError({
      layer: 2,
      code: "vec-lane-non-const",
      message: `vec.lane(i) requires a compile-time-constant index 0 | 1 | 2 | 3.`,
      refactorHint: `Use a JS number literal: vec.lane(0) — not a Node<'i32'>.`,
    });
  },
  mathPrecisionMismatch(a: string, b: string): never {
    throw new UnworkletCompileError({
      layer: 2,
      code: "precision-mismatch",
      message: `Operands disagree on precision (${a} vs ${b}).`,
      refactorHint: `unworklet does not implicitly widen between f32 and f64. Use f32(node) to narrow or f64(node) to widen explicitly at the boundary.`,
    });
  },
};
