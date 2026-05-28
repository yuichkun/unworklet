/**
 * Internal AST IR for graph capture (= plan Q-A).
 *
 * Tagged union with `kind` discriminant — exhaustive switch in
 * `analyze` / `layout` / `emit` stages catches missing branches at
 * TypeScript level, and the same shape serializes directly to
 * `dist/<processor>.graph.json` (= `07-vite-plugin.md` §6.3).
 *
 * Phase 7 sub-phase 7.1 で `stateLoad` / `stateStore` AstNode +
 * `StateDecl` declaration を 追 加 (= `01-dsl.md` §3.1 plain factory)。
 * 各 stage は 追 加 discriminant の switch case を 順 次 fill (= subset →
 * superset)。
 */

import type { ScalarType } from "../types.ts";

export type AstNode =
  | { kind: "literal"; type: ScalarType; value: number }
  | { kind: "mul"; type: ScalarType; lhs: AstNode; rhs: AstNode }
  | { kind: "audioInRead"; portName: string; channel: number; offset: AstNode }
  | {
      kind: "audioOutWrite";
      portName: string;
      channel: number;
      offset: AstNode;
      value: AstNode;
    }
  | { kind: "paramAt"; paramName: string; offset: AstNode }
  | { kind: "loopCounter" }
  | { kind: "forSample"; stride: number; body: AstNode[] }
  | { kind: "stateLoad"; type: ScalarType; name: string }
  | { kind: "stateStore"; type: ScalarType; name: string; value: AstNode };

export type AudioPortDecl = {
  kind: "audioInput" | "audioOutput";
  name: string;
  channels: number;
};

export type ParamDecl = {
  kind: "param";
  name: string;
  type: "f32";
  default: number;
  min: number;
  max: number;
  automationRate: "a-rate" | "k-rate";
};

/**
 * Scalar `state.<type>(initial)` slot declaration (`01-dsl.md` §3.1)。
 *
 * Phase 7 sub-phase 7.1 は plain factory (= `state.f32(0)` 等) のみ fill。
 * 7.2 で `.named('X')` / `.expose({ name, snapshot, publish })` chain
 * を 追 加 す る 時 に metadata field (= `snapshot` / `publish`) を
 * additive に 拡 張 (= 7.2 の commit で 追 加)。
 *
 * `initial` は scalar value (= f32/f64 → number、 i32 → number、 i64 →
 * bigint、 bool → boolean)。 SAB publish path (= 7.4) で の 型 変 換 と
 * 同 set。
 */
export type StateDecl = {
  kind: "state";
  name: string;
  type: ScalarType;
  initial: number | bigint | boolean;
};

export type Declaration = AudioPortDecl | ParamDecl | StateDecl;

export type CapturedGraph = {
  declarations: Declaration[];
  statements: AstNode[];
};
