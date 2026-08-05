/**
 * Ambient `.d.ts` surface for a `.uwk.ts` file. It makes every authoring
 * identifier a global (the author writes no imports) and types each one against
 * the REAL `@unworklet/core` types — so the lowering's `TypeChecker` queries see
 * the same `Node<T>` / `State<T>` / channel-view brands a hand-written Tier-A
 * file would, which is what makes the type-directed operator dispatch authoritative.
 *
 * Two divergences from core's own `.d.ts`, both load-bearing:
 * - `audioInput` / `audioOutput` make `name` optional (the auto-name / ambient
 *   passes fill it in before the lowered module reaches `compile()`).
 * - `process` / `migrations` / `options` / `input` / `out` / `ctx` / `$prev` are
 *   `.uwk.ts`-only ambients that have no `@unworklet/core` export.
 *
 * This same string is the program's in-memory type source AND (later) the shipped
 * `ambient.d.ts` for editor LSP — one source of truth.
 */
export const AMBIENT_DTS = `
import type { AudioInputHandle, AudioOutputHandle, ProcessorContext, ScalarType } from "@unworklet/core";

declare global {
  // Type aliases so a .uwk.ts can annotate L1-helper / subgraph signatures.
  type Node<T extends ScalarType | "f32x4" = ScalarType> = import("@unworklet/core").Node<T>;
  type State<T extends ScalarType> = import("@unworklet/core").State<T>;

  // ── Declaration helpers (reuse the exact runtime types of the core exports) ──
  const state: typeof import("@unworklet/core").state;
  const param: typeof import("@unworklet/core").param;
  const event: typeof import("@unworklet/core").event;
  const defineSubgraph: typeof import("@unworklet/core").defineSubgraph;
  const instantiate: typeof import("@unworklet/core").instantiate;
  const noiseSource: typeof import("@unworklet/core").noiseSource;

  // ── Audio I/O (name optional in .uwk.ts; the auto-name pass fills it) ──
  function audioInput<C extends number>(options: { channels: C; name?: string }): AudioInputHandle<C>;
  function audioOutput<C extends number>(options: { channels: C; name?: string }): AudioOutputHandle<C>;

  // ── Loop + control ──
  const forSample: typeof import("@unworklet/core").forSample;
  const select: typeof import("@unworklet/core").select;

  // ── Scalar constructors ──
  const f32: typeof import("@unworklet/core").f32;
  const f64: typeof import("@unworklet/core").f64;
  const i32: typeof import("@unworklet/core").i32;
  const i64: typeof import("@unworklet/core").i64;
  const bool: typeof import("@unworklet/core").bool;

  // ── Math / logical / composition free-function forms ──
  const add: typeof import("@unworklet/core").add;
  const sub: typeof import("@unworklet/core").sub;
  const mul: typeof import("@unworklet/core").mul;
  const div: typeof import("@unworklet/core").div;
  const mod: typeof import("@unworklet/core").mod;
  const neg: typeof import("@unworklet/core").neg;
  const eq: typeof import("@unworklet/core").eq;
  const lt: typeof import("@unworklet/core").lt;
  const gt: typeof import("@unworklet/core").gt;
  const lte: typeof import("@unworklet/core").lte;
  const gte: typeof import("@unworklet/core").gte;
  const not: typeof import("@unworklet/core").not;
  const sin: typeof import("@unworklet/core").sin;
  const cos: typeof import("@unworklet/core").cos;
  const tan: typeof import("@unworklet/core").tan;
  const tanh: typeof import("@unworklet/core").tanh;
  const exp: typeof import("@unworklet/core").exp;
  const log: typeof import("@unworklet/core").log;
  const sqrt: typeof import("@unworklet/core").sqrt;
  const floor: typeof import("@unworklet/core").floor;
  const ceil: typeof import("@unworklet/core").ceil;
  const frac: typeof import("@unworklet/core").frac;
  const abs: typeof import("@unworklet/core").abs;
  const min: typeof import("@unworklet/core").min;
  const max: typeof import("@unworklet/core").max;
  const clamp: typeof import("@unworklet/core").clamp;
  const pipe: typeof import("@unworklet/core").pipe;

  // ── Constants ──
  const SAMPLES_PER_BLOCK: typeof import("@unworklet/core").SAMPLES_PER_BLOCK;
  const CAPACITY_16: typeof import("@unworklet/core").CAPACITY_16;
  const CAPACITY_32: typeof import("@unworklet/core").CAPACITY_32;
  const CAPACITY_64: typeof import("@unworklet/core").CAPACITY_64;
  const CAPACITY_128: typeof import("@unworklet/core").CAPACITY_128;
  const CAPACITY_256: typeof import("@unworklet/core").CAPACITY_256;
  const CAPACITY_512: typeof import("@unworklet/core").CAPACITY_512;
  const CAPACITY_1024: typeof import("@unworklet/core").CAPACITY_1024;
  const CAPACITY_2048: typeof import("@unworklet/core").CAPACITY_2048;
  const CAPACITY_4096: typeof import("@unworklet/core").CAPACITY_4096;
  const CAPACITY_8192: typeof import("@unworklet/core").CAPACITY_8192;
  const CAPACITY_16384: typeof import("@unworklet/core").CAPACITY_16384;

  // ── .uwk.ts-only ambient macros + bindings (no @unworklet/core export) ──
  function process(callback: () => void): void;
  function migrations(list: unknown[]): void;
  function options(opts: unknown): void;
  const input: AudioInputHandle<2>;
  const out: AudioOutputHandle<2>;
  const ctx: ProcessorContext;
  /** Contextual keyword: the previous-call return value inside a defineSubgraph method. */
  const $prev: Node<ScalarType>;
}

export {};
`;
