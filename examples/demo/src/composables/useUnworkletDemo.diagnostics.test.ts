import { afterEach, expect, test, vi } from "vite-plus/test";
import { useUnworkletDemo } from "./useUnworkletDemo.ts";

const { compileSource, createNode, replaceProcessor } = vi.hoisted(() => ({
  compileSource: vi.fn(),
  createNode: vi.fn(),
  replaceProcessor: vi.fn(),
}));
vi.mock("@unworklet/lang/browser", () => ({ compileSource }));
vi.mock("@unworklet/core", () => ({ createNode, replaceProcessor }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
function setup() {
  const errorListeners: ((error: unknown) => void)[] = [];
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      currentTime = 0;
      destination = {};
      createGain() {
        return { gain: { value: 0 }, connect() {}, disconnect() {} };
      }
      close() {}
    },
  );
  createNode.mockResolvedValue({
    outputs: { main: { connect() {} } },
    params: {},
    onError: (listener: (error: unknown) => void) => errorListeners.push(listener),
    dispose() {},
  });
  compileSource.mockResolvedValue({});
  return { demo: useUnworkletDemo(), errorListeners };
}
const example = {
  slug: "test",
  title: "test",
  blurb: "test",
  kind: "effect" as const,
  source: "process(() => {});",
};

test("initial compilation retains a structured source error", async () => {
  const { demo } = setup();
  const failure = Object.assign(new Error("Use select"), { id: "uwk-unsupported-if" });
  compileSource.mockRejectedValueOnce(failure);
  await demo.prepare(example);
  expect(demo.failure.value).toEqual({
    phase: "compile",
    severity: "error",
    code: "uwk-unsupported-if",
    message: "Use select",
  });
  expect(demo.error.value).toContain("Use select");
});
test("explicit recompile retains a real range without inventing generated positions", async () => {
  const { demo } = setup();
  await demo.prepare(example);
  compileSource.mockRejectedValueOnce(
    Object.assign(new Error("Invalid token"), { id: "bad", sourceRange: { start: 3, length: 2 } }),
  );
  await demo.recompile("abcde");
  expect(demo.failure.value).toMatchObject({ phase: "compile", code: "bad", start: 3, length: 2 });
  expect(replaceProcessor).not.toHaveBeenCalled();
});
test("runtime errors remain document-level even when an external error includes a number", async () => {
  const { demo, errorListeners } = setup();
  await demo.prepare(example);
  errorListeners[0]!({
    code: "worklet-failure",
    message: "failed",
    sourceRange: { start: 3, length: 2 },
  });
  expect(demo.failure.value).toEqual({
    phase: "runtime",
    severity: "error",
    code: "worklet-failure",
    message: "failed",
  });
});
