import { afterAll, expect, test, vi } from "vite-plus/test";
import { captureFsSnapshot } from "../../../../packages/lang/src/capture.ts";
import { examples } from "../examples.ts";
import { createEditorLanguageService } from "./language-service.ts";

vi.setConfig({ testTimeout: 20_000 });
const snapshot = captureFsSnapshot();
const service = createEditorLanguageService(snapshot);
afterAll(() => service.dispose());
const uri = "file:///playground/test.uwk.ts";
let version = 0;
const query = (
  source: string,
  kind: "completion" | "hover" | "signature" | "diagnostics",
  offset = source.length,
) => service.query({ uri, version: ++version, source, kind, offset });

const source = `const input = audioInput({ channels: 2 });
const out = audioOutput({ channels: 2 });
const gain = param.f32({ default: 1, min: 0, max: 2, automationRate: "a-rate" });
process(() => { forSample((i) => {
  const l = input.left[i] * gain[i];
  out.left[i] = l;
}); });`;

test("snapshot-backed Volar hover preserves sugar-inferred Node type and source span", () => {
  const offset = source.indexOf("const l") + 6;
  const result = query(source, "hover", offset);
  expect(result.hover?.text).toContain('Node<"f32">');
  expect(source.slice(result.hover!.start, result.hover!.start + result.hover!.length)).toBe("l");
  expect(result.uri).toBe(uri);
  expect(result.version).toBe(version);
});

test.each([
  ["audioI", "audioInput"],
  ["state.", "buffer"],
  ["const input = audioInput({ channels: 2 }); input.", "left"],
  ["const input = audioInput({ channels: 1 }); input.", "ch"],
  ["function myHelper(x: number) { return x; } myH", "myHelper"],
])("completion handles incomplete source: %s", (text, name) => {
  const items = query(text, "completion").completions!;
  expect(items.some((item) => item.name === name)).toBe(true);
  expect(items.some((item) => item.name.startsWith("__uwk"))).toBe(false);
  expect(items.every((item) => !item.source)).toBe(true);
});

test("completion replacement span refers to original source after sugar", () => {
  const text = source.replace("out.left[i] = l;", "out.le");
  const offset = text.indexOf("out.le") + 6;
  const item = query(text, "completion", offset).completions!.find(
    (entry) => entry.name === "left",
  )!;
  expect(text.slice(item.start, item.start + item.length)).toBe("le");
  expect(
    text.slice(0, item.start) + item.insertText + text.slice(item.start + item.length),
  ).toContain("out.left");
});

test.each(["clamp(f32(0), ", "param.f32({ "])(
  "signature help survives an unclosed call: %s",
  (text) => {
    const signature = query(text, "signature").signature;
    expect(signature?.items.length).toBeGreaterThan(0);
    expect(signature?.items[0]?.label).toContain(text.startsWith("clamp") ? "clamp" : "f32");
  },
);

test.each([
  ["notDefined", "notDefined"],
  ["state.noSuchMethod()", "noSuchMethod"],
  [
    "const out = audioOutput({ channels: 1 }); process(() => { forSample((i) => { out.ch(0)[i] = bool(true); }); });",
    "bool(true)",
  ],
])("diagnostic ranges point into author text: %s", (text, token) => {
  const diagnostics = query(text, "diagnostics").diagnostics!;
  expect(
    diagnostics.some(
      (d) =>
        d.phase === "type" &&
        d.start !== undefined &&
        text.slice(d.start, d.start + d.length!).includes(token),
    ),
  ).toBe(true);
});

test("syntax errors are source mapped and disappear after correction", () => {
  expect(
    query("process(() => {", "diagnostics").diagnostics!.some((d) => d.phase === "syntax"),
  ).toBe(true);
  expect(query(source, "diagnostics").diagnostics).toEqual([]);
});

test.each(examples)("bundled $slug example has no false diagnostics", (example) => {
  expect(query(example.source, "diagnostics").diagnostics).toEqual([]);
});

test("unsupported DSP if identifies its actual source condition", () => {
  const text = `const s = state.f32(0); process(() => { forSample(() => { if (s > 0) { s.write(1); s.write(2); } }); });`;
  expect(query(text, "diagnostics").diagnostics).toContainEqual(
    expect.objectContaining({
      phase: "lowering",
      code: "uwk-unsupported-if",
      start: text.indexOf("s > 0"),
      length: 5,
    }),
  );
});

test("analysis never evaluates author code", () => {
  const marker = "__uwk_editor_executed__";
  query(`globalThis.${marker} = true; process(() => {});`, "diagnostics");
  expect(marker in globalThis).toBe(false);
});

test("channel-dependent completion does not advertise stereo members on a mono input", () => {
  const text = "const input = audioInput({ channels: 1 }); input.";
  const names = query(text, "completion").completions!.map((item) => item.name);
  expect(names).toContain("ch");
  expect(names).not.toContain("left");
  expect(names).not.toContain("right");
});

test("partial index and nested unfinished expressions do not crash assistance", () => {
  for (const text of [
    "input.left[",
    "process(() => { forSample((i) => { const x = input.left[i] *",
    "const gain = param.f32(",
  ]) {
    expect(() => query(text, "completion")).not.toThrow();
    expect(() => query(text, "diagnostics")).not.toThrow();
  }
});

test("a lowering error without an author range stays document-level", () => {
  const diagnostics = query("const value = f32(1);", "diagnostics").diagnostics!;
  expect(diagnostics).toContainEqual(
    expect.objectContaining({ code: "uwk-empty", phase: "lowering" }),
  );
  expect(diagnostics.find((item) => item.code === "uwk-empty")).not.toHaveProperty("start");
});

test("completion replaces the complete author token when requested mid-word", () => {
  const text = "audioInpt";
  const item = query(text, "completion", 7).completions!.find(
    (entry) => entry.name === "audioInput",
  )!;
  expect(text.slice(0, item.start) + item.insertText + text.slice(item.start + item.length)).toBe(
    "audioInput",
  );
});

test.each([
  `const s = state.f32(0).named(); process(() => { forSample(() => { if (s > 0) s.write(1); else s.write(0); }); });`,
  `const s = state.f32(0).named(); const ev = event<{ level: number }>({ to: "main" }); process(() => { forSample(() => { if (s > 0) ev.emit({ level: s }); }); });`,
  `const buf = state.buffer.f32({ size: 8 }).named(); const s = state.i32(0).named(); process(() => { forSample(() => { if (s > 0) buf[s] = 1; }); });`,
])("accepted DSP if sugar has no raw-TypeScript false errors", (text) => {
  expect(query(text, "diagnostics").diagnostics).toEqual([]);
});
