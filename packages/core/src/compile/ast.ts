/**
 * Internal AST IR for graph capture (= plan Q-A).
 *
 * Tagged union with `kind` discriminant — exhaustive switch in
 * `analyze` / `layout` / `emit` stages catches missing branches at
 * TypeScript level, and the same shape serializes directly to
 * `dist/<processor>.graph.json` (= `07-vite-plugin.md` §6.3).
 *
 * Phase 3 covers 7 kinds: `literal` / `mul` / `audioInRead` /
 * `audioOutWrite` / `paramAt` / `loopCounter` / `forSample`. Later
 * phases extend the union additively (= add a discriminant + branch
 * per new primitive / declaration kind).
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
  | { kind: "forSample"; stride: number; body: AstNode[] };

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

export type Declaration = AudioPortDecl | ParamDecl;

export type CapturedGraph = {
  declarations: Declaration[];
  statements: AstNode[];
};
