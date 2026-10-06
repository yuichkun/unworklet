import { beforeAll, expect, test } from "vite-plus/test";

import { f32, f64 } from "../dsl/constructors.ts";
import type { Node } from "../types.ts";
import { event, state } from "../dsl/declarations.ts";
import { defineProcessor } from "../processor.ts";
import { compile } from "./index.ts";
import { emitExpression } from "./emit.ts";
import { layout as makeLayout, type Layout } from "./layout.ts";
import "../dsl/primitives.ts";

type FloatType = "f32" | "f64";
type RemainderFixture = {
  run: (a: number, b: number) => number;
  nested: (a: number, b: number, c: number, d: number) => number;
};
const fixtures = new Map<FloatType, RemainderFixture>();

beforeAll(async () => {
  for (const type of ["f32", "f64"] as const) {
    const remainder =
      type === "f32"
        ? (a: Node<FloatType>, b: Node<FloatType>) => f32(a).mod(f32(b))
        : (a: Node<FloatType>, b: Node<FloatType>) => f64(a).mod(f64(b));
    const processor = defineProcessor(() => {
      const input = state.buffer[type]({ size: 4 }).named("input");
      const output = event<{ value: number; nested: number }>({ to: "main", name: "output" });
      return {
        process: () => {
          output.emitIf(true, {
            value: remainder(input.read(0), input.read(1)),
            nested: remainder(
              remainder(input.read(0), input.read(1)),
              remainder(input.read(2), input.read(3)),
            ),
          });
        },
      };
    });
    const compiled = await compile(processor);
    const instance = await compiled.driver.instantiate();
    const layout = compiled.memory as unknown as Layout;
    const memory = new DataView(instance.memory.buffer);
    const setInput = (values: number[]): void => {
      for (const [index, value] of values.entries()) {
        const base = layout.regions.buffers.slots.input!;
        if (type === "f32") memory.setFloat32(base + index * 4, value, true);
        else memory.setFloat64(base + index * 8, value, true);
      }
    };
    // Event fields are raw stores: state and buffer stores intentionally flush
    // tiny results and -0, and audio outputs scrub NaN/Infinity and demote f64.
    const ring = layout.regions.eventRings.slots.output!;
    const output = new DataView(instance.memory.buffer);
    const read = (field: string): number => {
      const offset =
        ring.base + 12 + ring.fields.find((entry) => entry.name === field)!.offsetInSlot;
      return type === "f32" ? output.getFloat32(offset, true) : output.getFloat64(offset, true);
    };
    const resetRing = (): void => {
      output.setUint32(ring.base, 0, true);
      output.setUint32(ring.base + 4, 0, true);
    };
    fixtures.set(type, {
      run(a, b) {
        setInput([a, b, 3, 2]);
        resetRing();
        instance.process();
        return read("value");
      },
      nested(a, b, c, d) {
        setInput([a, b, c, d]);
        resetRing();
        instance.process();
        return read("nested");
      },
    });
  }
});

for (const type of ["f32", "f64"] as const) {
  const round = type === "f32" ? Math.fround : (value: number) => value;
  const check = (a: number, b: number): void => {
    // The oracle uses the same input values as WASM, including f32 rounding.
    const expected = round(round(a) % round(b));
    expect(fixtures.get(type)!.run(a, b), `${type}: ${a} % ${b}`).toBe(expected);
  };

  test(`${type} remainder preserves finite remainders lost by rounded division`, () => {
    for (const [a, b] of [
      [100_000_000, 3],
      [-100_000_000, 3],
      [1, 0.1],
      [100_000_002_004_087_730_000, 3],
      [7.5, 2],
      [7, -3],
    ]) {
      check(a!, b!);
    }
  });

  test(`${type} remainder preserves signed zero and all non-finite cases`, () => {
    const values = [0, -0, 1, -1, 2, -2, Infinity, -Infinity, NaN];
    for (const a of values) for (const b of values) check(a, b);
  });

  test(`${type} remainder is exact across normal and subnormal exponent boundaries`, () => {
    const exponents =
      type === "f32"
        ? [-149, -148, -127, -126, -125, -24, -1, 0, 1, 23, 24, 25, 126, 127]
        : [-1074, -1073, -1023, -1022, -1021, -53, -1, 0, 1, 52, 53, 54, 1022, 1023];
    const maximum = type === "f32" ? round(3.4028234663852886e38) : Number.MAX_VALUE;
    const minimum = type === "f32" ? 2 ** -149 : Number.MIN_VALUE;
    const minimumNormal = type === "f32" ? 2 ** -126 : 2 ** -1022;
    const previousMaximum = maximum - 2 ** (type === "f32" ? 104 : 971);
    const values = [
      maximum,
      previousMaximum,
      minimumNormal - minimum,
      minimumNormal + minimum,
      ...exponents.flatMap((e) => [2 ** e, round(1.5 * 2 ** e)]),
    ];
    for (const a of values) {
      for (const b of values) {
        for (const signA of [-1, 1]) for (const signB of [-1, 1]) check(a * signA, b * signB);
      }
    }
  });

  test(`${type} remainder matches JavaScript for deterministic random IEEE bit patterns`, () => {
    const storage = new ArrayBuffer(8);
    const bits = new Uint32Array(storage);
    const values = type === "f32" ? new Float32Array(storage) : new Float64Array(storage);
    let seed = 0x1a2b3c4d;
    const nextWord = (): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    const nextValue = (): number => {
      bits[0] = nextWord();
      bits[1] = nextWord();
      return values[0]!;
    };
    for (let i = 0; i < 10_000; i++) check(nextValue(), nextValue());
  });

  test(`${type} nested remainders keep both operands independent`, () => {
    for (const [a, b, c, d] of [
      [100_000_000, 3, 7, 3],
      [1, 0.1, 1, 0.3],
      [-6, 3, 5, 3],
    ]) {
      const lhs = round(round(a!) % round(b!));
      const rhs = round(round(c!) % round(d!));
      expect(fixtures.get(type)!.nested(a!, b!, c!, d!)).toBe(round(lhs % rhs));
    }
  });
}

test("remainder helpers are emitted once per used floating type, and never for integer mod", async () => {
  const binaryen = (await import("binaryen")).default;
  const module = new binaryen.Module();
  const layout = makeLayout({ declarations: [], statements: [] });
  try {
    for (const [type, expectedHelpers] of [
      ["i32", 0],
      ["i64", 0],
      ["f32", 1],
      ["f32", 1],
      ["f64", 2],
      ["f64", 2],
    ] as const) {
      emitExpression(
        {
          kind: "mod",
          type,
          lhs: { kind: "literal", type, value: 7 },
          rhs: { kind: "literal", type, value: 3 },
        },
        layout,
        module,
        binaryen,
      );
      expect(module.getNumFunctions()).toBe(expectedHelpers);
    }
  } finally {
    module.dispose();
  }
});
