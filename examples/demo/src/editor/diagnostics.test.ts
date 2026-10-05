import { expect, test } from "vite-plus/test";
import { diagnosticFromError } from "./diagnostics.ts";

test("structured compile error preserves its code, message and trustworthy author range", () => {
  expect(
    diagnosticFromError(
      { id: "uwk-unsupported-if", message: "Use select", sourceRange: { start: 2, length: 3 } },
      "compile",
      10,
    ),
  ).toEqual({
    phase: "compile",
    severity: "error",
    code: "uwk-unsupported-if",
    message: "Use select",
    start: 2,
    length: 3,
  });
});
test.each([
  new Error("failed at generated.ts:5"),
  "line 8 failed",
  { code: "BAD", message: "oops", start: -1, length: 2 },
  { start: 2, length: 100 },
  { start: 0.5, length: 1 },
  null,
])("unpositioned failures stay document-level: %s", (error) => {
  expect(diagnosticFromError(error, "runtime", 10)).not.toHaveProperty("start");
});

test.each([
  { start: 2, length: 1 },
  { sourceRange: { start: -1, length: 1 } },
  { sourceRange: { start: 0.5, length: 1 } },
  { sourceRange: { start: 2, length: 100 } },
  { sourceRange: { start: 2, length: -1 } },
  { sourceRange: null },
])("only a valid explicitly source-tagged range becomes a compile marker", (error) => {
  expect(diagnosticFromError(error, "compile", 10)).not.toHaveProperty("start");
});

test.each([
  { code: "queue-overflow", source: "midi", name: "keys", dropped: 2 },
  { code: "block-length-mismatch", expected: 128, received: 64 },
  { code: "sab-unavailable" },
  { code: "worklet-initialize-not-called" },
] satisfies import("@unworklet/core").NodeErrorEvent[])(
  "real worklet event details stay readable: $code",
  (event) => {
    const diagnostic = diagnosticFromError(event, "runtime", 0);
    expect(diagnostic.code).toBe(event.code);
    expect(JSON.parse(diagnostic.message)).toEqual(event);
    expect(diagnostic).not.toHaveProperty("start");
  },
);

test("unserializable thrown objects do not break the error panel", () => {
  const object: Record<string, unknown> = { code: "custom-error" };
  object.circular = object;
  expect(() => diagnosticFromError(object, "compile", 0)).not.toThrow();
});
