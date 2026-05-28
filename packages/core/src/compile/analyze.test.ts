/**
 * Behavior of the static-analysis stage (= `03-compiler.md` §3、
 * plan Q-D stage 別 internal module の 1 つ目)。
 *
 * Phase 3 = noop = `[]` 返 す だ け (= layered error model の Layer 3
 * check は 後 続 phase で fill、 plan「analyze は Phase 3 = noop」 規 定)。
 */

import { expect, test } from "vite-plus/test";

import { analyze } from "./analyze.ts";
import type { CapturedGraph } from "./ast.ts";

const emptyGraph: CapturedGraph = { declarations: [], statements: [] };

const populatedGraph: CapturedGraph = {
  declarations: [
    { kind: "audioInput", name: "main", channels: 2 },
    { kind: "audioOutput", name: "main", channels: 2 },
    {
      kind: "param",
      name: "gain",
      type: "f32",
      default: 1,
      min: 0,
      max: 4,
      automationRate: "a-rate",
    },
  ],
  statements: [{ kind: "forSample", stride: 1, body: [] }],
};

test("`analyze(emptyGraph)` returns an empty diagnostics array", () => {
  expect(analyze(emptyGraph)).toEqual([]);
});

test("`analyze(populatedGraph)` returns an empty diagnostics array (= Phase 3 noop)", () => {
  expect(analyze(populatedGraph)).toEqual([]);
});

// ─────────────────────────────────────────────────────────────────────────
// Q32-c: constant-truthy `emitIf` inside `forSample` = static-analysis error
// (`01-dsl.md` §4.1 + `decisions-log.md` Q32-c)。 stable ID = `constant-truthy-emitif`。
// ─────────────────────────────────────────────────────────────────────────

const constantTruthyEmitInForSample: CapturedGraph = {
  declarations: [
    {
      kind: "event",
      name: "peak",
      capacity: 256,
      payloadCapacity: undefined,
      fields: [{ name: "level", wireType: "f32" }],
    },
  ],
  statements: [
    {
      kind: "forSample",
      stride: 1,
      body: [
        {
          kind: "eventEmitIf",
          name: "peak",
          cond: { kind: "literal", type: "i32", value: 1 }, // truthy literal
          atSample: { kind: "loopCounter" },
          fields: [
            {
              name: "level",
              wireType: "f32",
              value: { kind: "literal", type: "f32", value: 0.5 },
            },
          ],
        },
      ],
    },
  ],
};

test("`analyze`: forSample 内 で cond literal truthy = error diagnostic + stable ID", () => {
  const diags = analyze(constantTruthyEmitInForSample);
  expect(diags).toHaveLength(1);
  expect(diags[0]).toMatchObject({
    id: "constant-truthy-emitif",
    severity: "error",
  });
  expect(diags[0]!.message).toMatch(/peak/);
});

test("`analyze`: forSample 内 で cond literal falsy (= 0) = error ナ シ", () => {
  // falsy literal は graph-capture-time fold で drop さ れ る 規 範 だ が、 仮 に
  // AST に 残 っ て も analyze で error 出 さ な い (= unconditional 「fire ナ シ」
  // = ringbuffer 詰 ま ら な い、 違 反 軸 で は な い)。
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "event",
        name: "peak",
        capacity: 256,
        payloadCapacity: undefined,
        fields: [{ name: "level", wireType: "f32" }],
      },
    ],
    statements: [
      {
        kind: "forSample",
        stride: 1,
        body: [
          {
            kind: "eventEmitIf",
            name: "peak",
            cond: { kind: "literal", type: "i32", value: 0 },
            atSample: { kind: "loopCounter" },
            fields: [
              {
                name: "level",
                wireType: "f32",
                value: { kind: "literal", type: "f32", value: 0.5 },
              },
            ],
          },
        ],
      },
    ],
  };
  expect(analyze(graph)).toEqual([]);
});

test("`analyze`: per-block top で cond literal truthy = error ナ シ (= 規 範 spelling)", () => {
  // handler context / per-block top level で の `emitIf(true, payload)` は
  // canonical unconditional emission = OK。 forSample 限 定 の error。
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "event",
        name: "peak",
        capacity: 256,
        payloadCapacity: undefined,
        fields: [{ name: "level", wireType: "f32" }],
      },
    ],
    statements: [
      {
        kind: "eventEmitIf",
        name: "peak",
        cond: { kind: "literal", type: "i32", value: 1 },
        atSample: { kind: "literal", type: "i32", value: 0 },
        fields: [
          {
            name: "level",
            wireType: "f32",
            value: { kind: "literal", type: "f32", value: 0.5 },
          },
        ],
      },
    ],
  };
  expect(analyze(graph)).toEqual([]);
});

test("`analyze`: forSample 内 で cond non-literal (= stateLoad) = error ナ シ", () => {
  // state-edge gated cond = 動 的 = OK。 forSample 内 の constant-truthy だ け を
  // reject す る 規 範。
  const graph: CapturedGraph = {
    declarations: [
      { kind: "state", name: "gate", type: "bool", initial: false, userNamed: true },
      {
        kind: "event",
        name: "peak",
        capacity: 256,
        payloadCapacity: undefined,
        fields: [{ name: "level", wireType: "f32" }],
      },
    ],
    statements: [
      {
        kind: "forSample",
        stride: 1,
        body: [
          {
            kind: "eventEmitIf",
            name: "peak",
            cond: { kind: "stateLoad", type: "bool", name: "gate" },
            atSample: { kind: "loopCounter" },
            fields: [
              {
                name: "level",
                wireType: "f32",
                value: { kind: "literal", type: "f32", value: 0.5 },
              },
            ],
          },
        ],
      },
    ],
  };
  expect(analyze(graph)).toEqual([]);
});

test("`analyze`: nested forSample 内 で 全 emit を 走 査 + 複 数 違 反 を 全 報 告", () => {
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "event",
        name: "a",
        capacity: 256,
        payloadCapacity: undefined,
        fields: [],
      },
      {
        kind: "event",
        name: "b",
        capacity: 256,
        payloadCapacity: undefined,
        fields: [],
      },
    ],
    statements: [
      {
        kind: "forSample",
        stride: 1,
        body: [
          {
            kind: "eventEmitIf",
            name: "a",
            cond: { kind: "literal", type: "i32", value: 1 },
            atSample: { kind: "loopCounter" },
            fields: [],
          },
          {
            kind: "eventEmitIf",
            name: "b",
            cond: { kind: "literal", type: "i32", value: 1 },
            atSample: { kind: "loopCounter" },
            fields: [],
          },
        ],
      },
    ],
  };
  const diags = analyze(graph);
  expect(diags).toHaveLength(2);
  expect(diags.every((d) => d.id === "constant-truthy-emitif")).toBe(true);
});
