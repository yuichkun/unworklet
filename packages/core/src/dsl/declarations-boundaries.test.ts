import { expect, test } from "vite-plus/test";

import { defineProcessor } from "../processor.ts";
import { newCaptureContext, runCapture } from "../compile/capture.ts";
import { bool, f32, i64 } from "./constructors.ts";
import { event, param, state } from "./declarations.ts";
import { add } from "./primitives.ts";

test.each([-1, Number.NaN, Infinity, 3, 4])(
  "interpolation rejects literal position %s without a complete two-tap window",
  (position) => {
    expect(() =>
      defineProcessor(() => {
        const samples = state.buffer.f32({ size: 4 });
        return {
          process: () => {
            samples.readInterpolated(position);
          },
        };
      }),
    ).toThrow(/readInterpolated.*out of range/);
  },
);

test("u8 interpolation captures an integer result for an in-bounds position", () => {
  const capture = newCaptureContext();
  runCapture(capture, () => {
    const bytes = state.buffer.u8({ size: 4 });
    bytes.write(0, 3.9);
    bytes.readInterpolated(1.5);
  });
  expect(capture.statements).toEqual([
    {
      kind: "bufferWrite",
      elementType: "u8",
      name: "__buffer_0",
      index: { kind: "literal", type: "i32", value: 0 },
      value: { kind: "literal", type: "i32", value: 3 },
    },
    {
      kind: "tempAssign",
      tempId: 0,
      valueType: "i32",
      value: {
        kind: "bufferReadInterpolated",
        elementType: "u8",
        name: "__buffer_0",
        pos: { kind: "literal", type: "f32", value: 1.5 },
      },
    },
  ]);
});

test("reusing a buffer's exposed name retains a stable persistent identity", () => {
  const capture = newCaptureContext();
  runCapture(capture, () => {
    state.buffer.f32({ size: 4 }).expose({ name: "__buffer_0", snapshot: "persistent" });
  });
  expect(capture.declarations).toContainEqual(
    expect.objectContaining({
      kind: "buffer",
      name: "__buffer_0",
      userNamed: true,
      snapshot: "persistent",
    }),
  );
});

test("a parameter's post-declaration exposure can rename it without changing snapshot policy", () => {
  const capture = newCaptureContext();
  runCapture(capture, () => {
    const gain = param.named("gain").expose({ snapshot: "transient" }).f32({
      default: 1,
      min: 0,
      max: 2,
      automationRate: "k-rate",
    });
    gain.expose({ name: "level" });
    gain.expose({});
  });
  expect(capture.declarations).toEqual([
    {
      kind: "param",
      name: "level",
      type: "f32",
      default: 1,
      min: 0,
      max: 2,
      automationRate: "k-rate",
      snapshot: "transient",
    },
  ]);
});

test("sysex cannot be copied into a floating-point sample buffer", () => {
  expect(() =>
    defineProcessor(() => {
      const input = event.midi({ from: "main", name: "input" });
      const samples = state.buffer.f32({ size: 8 });
      return {
        process: () =>
          input.onEvent("sysex", ({ data }) => {
            // @ts-expect-error JavaScript callers can supply a differently typed field.
            samples.copyFrom(data);
          }),
      };
    }),
  ).toThrow(/requires a buffer.u8/);
});

test.each([null, 1])("sysex rejects an invalid content reference %s", (data) => {
  expect(() =>
    defineProcessor(() => {
      const output = event.midi({ to: "main", name: "output" });
      return {
        process: () => {
          // @ts-expect-error JavaScript callers can pass invalid content references.
          output.emitIf(true, { type: "sysex", data, length: 1 });
        },
      };
    }),
  ).toThrow(/sysex `data` must be a buffer.u8/);
});

test("an event cannot change a scalar field into a typed array at another emit site", () => {
  expect(() =>
    defineProcessor(() => {
      const output = event<{ data: number }>({ to: "main", name: "output" });
      const samples = state.buffer.f32({ size: 4 });
      return {
        process: () => {
          output.emitIf(true, { data: f32(1) });
          // @ts-expect-error JavaScript callers can mix scalar and typed-array payloads.
          output.emitIf(true, { data: samples, length: 4 });
        },
      };
    }),
  ).toThrow(/introduces new typed-array field "data"/);
});

test("multiple typed-array emit sites retain one consistent field layout", () => {
  const capture = newCaptureContext();
  runCapture(capture, () => {
    const output = event<{ data: Float32Array }>({ to: "main", name: "output" });
    const first = state.buffer.f32({ size: 4 });
    const second = state.buffer.f32({ size: 8 });
    output.emitIf(true, { data: first, length: 4 });
    output.emitIf(true, { data: second, length: 8 });
  });
  expect(capture.declarations).toContainEqual(
    expect.objectContaining({
      kind: "event",
      fields: [{ name: "data", wireType: "i32", payloadElementType: "f32" }],
    }),
  );
  expect(capture.statements.filter((statement) => statement.kind === "eventEmitIf")).toHaveLength(
    2,
  );
});

test("typed-array emit sites cannot disagree on the element width", () => {
  expect(() =>
    defineProcessor(() => {
      const output = event<{ data: Float32Array }>({ to: "main", name: "output" });
      const samples = state.buffer.f32({ size: 4 });
      const bytes = state.buffer.u8({ size: 4 });
      return {
        process: () => {
          output.emitIf(true, { data: samples, length: 4 });
          // @ts-expect-error Runtime backstop for conflicting payload types from JavaScript callers.
          output.emitIf(true, { data: bytes, length: 4 });
        },
      };
    }),
  ).toThrow(/element-type mismatch.*f32.*u8/);
});

test("a literal false outbound field stays a boolean wire value", () => {
  const capture = newCaptureContext();
  runCapture(capture, () => {
    const output = event<{ enabled: boolean }>({ to: "main", name: "output" });
    output.emitIf(true, { enabled: false });
  });
  expect(capture.declarations).toContainEqual(
    expect.objectContaining({
      kind: "event",
      fields: [{ name: "enabled", wireType: "bool" }],
    }),
  );
  expect(capture.statements).toContainEqual(
    expect.objectContaining({
      kind: "eventEmitIf",
      fields: [
        {
          name: "enabled",
          wireType: "bool",
          value: { kind: "literal", type: "i32", value: 0 },
        },
      ],
    }),
  );
});

test("i64 arithmetic requires explicit bigint constants instead of an imprecise number lift", () => {
  expect(() => add(i64(2n ** 60n), 1)).toThrow(/number literal cannot lift to i64/);
  expect(() => add(i64(2n ** 60n), i64(1n))).not.toThrow();
});

test.each([null, undefined, "gain"])("numeric operators reject the invalid operand %s", (value) => {
  // @ts-expect-error Runtime guard for JavaScript callers.
  expect(() => add(f32(1), value)).toThrow();
});

test("boolean buffer writes preserve typed scalar fields", () => {
  const capture = newCaptureContext();
  runCapture(capture, () => {
    const input = event<{ enabled: boolean }>({ from: "main", name: "input" });
    const flags = state.buffer.bool({ size: 4 });
    input.onReceive(({ enabled }) => {
      flags.write(0, enabled);
      flags.write(1, bool(false));
    });
  });
  expect(capture.declarations).toContainEqual(
    expect.objectContaining({
      kind: "message",
      fields: [{ name: "enabled", wireType: "bool" }],
    }),
  );
});
