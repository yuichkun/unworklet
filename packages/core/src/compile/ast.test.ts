import { describe, expect, test } from "vite-plus/test";

import { type AstNode, inferAstType } from "./ast.ts";

const f32: AstNode = { kind: "literal", type: "f32", value: 1.5 };
const f64: AstNode = { kind: "literal", type: "f64", value: 2.5 };
const i32: AstNode = { kind: "literal", type: "i32", value: 1 };
const bool: AstNode = { kind: "literal", type: "bool", value: 1 };
const vector: AstNode = { kind: "vecSplat", value: f32 };

describe("inferAstType", () => {
  test.each(["f32", "f64", "i32", "i64", "bool"] as const)(
    "preserves %s scalar metadata on literals, state, temporaries, and message fields",
    (type) => {
      expect(inferAstType({ kind: "literal", type, value: type === "i64" ? 1n : 1 })).toBe(type);
      expect(inferAstType({ kind: "stateLoad", type, name: "value" })).toBe(type);
      expect(inferAstType({ kind: "tempRef", type, tempId: 0 })).toBe(type);
      expect(
        inferAstType({ kind: "messageFieldRead", name: "input", field: "value", wireType: type }),
      ).toBe(type);
    },
  );

  test.each(["mul", "add", "sub", "div", "mod", "pow", "max", "min"] as const)(
    "%s preserves double precision rather than defaulting to f32",
    (kind) => {
      expect(inferAstType({ kind, type: "f64", lhs: f64, rhs: f64 })).toBe("f64");
    },
  );

  test.each([
    "abs",
    "neg",
    "sqrt",
    "floor",
    "ceil",
    "frac",
    "sin",
    "cos",
    "tan",
    "tanh",
    "exp",
    "log",
  ] as const)("%s preserves its recorded scalar result type", (kind) => {
    expect(inferAstType({ kind, type: "f64", value: f64 })).toBe("f64");
  });

  test("clamp and select preserve their scalar value type", () => {
    expect(inferAstType({ kind: "clamp", type: "i32", x: i32, lo: i32, hi: i32 })).toBe("i32");
    expect(
      inferAstType({ kind: "select", type: "f64", cond: bool, ifTrue: f64, ifFalse: f64 }),
    ).toBe("f64");
  });

  test("conversion reports the destination type rather than the source type", () => {
    expect(inferAstType({ kind: "convert", type: "i32", from: "f64", value: f64 })).toBe("i32");
    expect(inferAstType({ kind: "convert", type: "f64", from: "i32", value: i32 })).toBe("f64");
  });

  test.each(["eq", "lt", "gt", "lte", "gte"] as const)(
    "%s produces bool rather than its numeric operand type",
    (kind) => {
      expect(inferAstType({ kind, type: "f64", lhs: f64, rhs: f64 })).toBe("bool");
    },
  );

  test("logical operations produce bool", () => {
    expect(inferAstType({ kind: "not", type: "bool", value: bool })).toBe("bool");
    expect(inferAstType({ kind: "and", type: "bool", lhs: bool, rhs: bool })).toBe("bool");
    expect(inferAstType({ kind: "or", type: "bool", lhs: bool, rhs: bool })).toBe("bool");
  });

  test.each([
    { kind: "audioInRead", portName: "input", channel: 0, offset: i32 },
    { kind: "paramAt", paramName: "gain", offset: i32 },
    { kind: "noiseSourceNext", type: "f32", name: "noise" },
    { kind: "vecLane", index: 2, value: vector },
    { kind: "vecSumLanes", value: vector },
  ] satisfies AstNode[])("$kind produces scalar f32", (node) => {
    expect(inferAstType(node)).toBe("f32");
  });

  test.each([
    { kind: "loopCounter" },
    { kind: "loopCounter", depth: 1 },
    { kind: "midiSysexLength", port: "midi" },
    { kind: "payloadFieldLength", messageName: "input", field: "samples", elementType: "f64" },
  ] satisfies AstNode[])("$kind produces an i32 index or length", (node) => {
    expect(inferAstType(node)).toBe("i32");
  });

  test.each(["status", "channel", "data1", "data2", "atSample", "pitchBend14"] as const)(
    "decoded MIDI field %s produces i32",
    (field) => {
      expect(inferAstType({ kind: "midiFieldRead", field })).toBe("i32");
    },
  );

  test.each([
    ["f32", "f32"],
    ["f64", "f64"],
    ["i32", "i32"],
    ["i64", "i64"],
    ["bool", "bool"],
    ["u8", "i32"],
  ] as const)("buffer and payload %s reads produce %s", (elementType, expected) => {
    expect(inferAstType({ kind: "bufferRead", elementType, name: "samples", index: i32 })).toBe(
      expected,
    );
    expect(
      inferAstType({
        kind: "payloadFieldRead",
        elementType,
        messageName: "input",
        field: "samples",
        index: i32,
      }),
    ).toBe(expected);
  });

  test.each(["f32", "f64"] as const)("interpolated %s reads preserve precision", (elementType) => {
    expect(
      inferAstType({ kind: "bufferReadInterpolated", elementType, name: "samples", pos: f32 }),
    ).toBe(elementType);
  });

  test.each([
    { kind: "tempRef", type: "f32x4", tempId: 0 },
    { kind: "vecConst", lanes: [f32, f32, f32, f32] },
    { kind: "vecSplat", value: f32 },
    { kind: "vecAdd", lhs: vector, rhs: vector },
    { kind: "vecSub", lhs: vector, rhs: vector },
    { kind: "vecMul", lhs: vector, rhs: vector },
    { kind: "vecDiv", lhs: vector, rhs: vector },
    { kind: "bufferLoadVec", name: "samples", offset: i32 },
  ] satisfies AstNode[])("rejects $kind vectors in scalar expression positions", (node) => {
    expect(() => inferAstType(node)).toThrow(
      `f32x4 node '${node.kind}' cannot appear in scalar position`,
    );
  });

  test.each([
    { kind: "bufferStoreVec", name: "samples", offset: i32, value: vector },
    { kind: "audioOutWrite", portName: "output", channel: 0, offset: i32, value: f32 },
    { kind: "forSample", stride: 1, body: [] },
    { kind: "stateStore", type: "f64", name: "value", value: f64 },
    { kind: "eventEmitIf", name: "output", cond: bool, atSample: i32, fields: [] },
    { kind: "messageOnReceive", name: "input", body: [] },
    { kind: "bufferWrite", elementType: "f32", name: "samples", index: i32, value: f32 },
    {
      kind: "bufferCopyFrom",
      elementType: "f32",
      bufferName: "samples",
      bufferSize: 128,
      messageName: "input",
      field: "samples",
    },
    { kind: "everyNSamples", divisor: 4, stride: 1, counterId: 0, body: [] },
    { kind: "tempAssign", tempId: 0, valueType: "f32", value: f32 },
    { kind: "midiOnEvent", port: "midi", eventType: "noteOn", body: [] },
    {
      kind: "midiEmitIf",
      port: "midi",
      eventType: "noteOn",
      cond: bool,
      atSample: i32,
      channel: i32,
      arg1: i32,
      arg2: i32,
    },
    { kind: "midiSysexCopy", port: "midi", bufferName: "bytes", bufferSize: 128 },
  ] satisfies AstNode[])("rejects $kind statements in expression positions", (node) => {
    expect(() => inferAstType(node)).toThrow(
      `statement node '${node.kind}' cannot appear in expression position`,
    );
  });
});
