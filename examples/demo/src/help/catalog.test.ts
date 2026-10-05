import { expect, test } from "vite-plus/test";
import ts from "typescript";
import { renderOffline } from "@unworklet/offline";
import { captureFsSnapshot } from "../../../../packages/lang/src/capture.ts";
import { lower } from "../../../../packages/lang/src/lower.ts";
import { lowerToProcessor } from "../../../../packages/lang/src/eval-lowered.ts";
import { AMBIENT_DTS } from "../../../../packages/lang/src/ambient.ts";
import { apiEntries, filterEntries, sugarEntries, unsupportedExamples } from "./catalog.ts";
import { createHelpSignatures } from "./signatures.ts";

const snapshot = captureFsSnapshot();
const compact = (source: string) => source.replace(/\s+/g, "");

test("reference finds APIs by name, purpose, category, and empty results", () => {
  for (const name of [
    "sin",
    "clamp",
    "state.buffer.f32",
    "param.f32",
    "event.midi",
    "defineSubgraph",
  ]) {
    expect(filterEntries(apiEntries, name, "all").some((entry) => entry.name === name)).toBe(true);
  }
  expect(filterEntries(apiEntries, "limit", "all").some((entry) => entry.name === "clamp")).toBe(
    true,
  );
  expect(filterEntries(apiEntries, "", "I/O").every((entry) => entry.category === "I/O")).toBe(
    true,
  );
  expect(filterEntries(apiEntries, "no-such-operator", "all")).toEqual([]);
  expect(filterEntries(sugarEntries, "short-circuit", "all").length).toBeGreaterThan(0);
});

test("curated names and signatures resolve against the actual ambient/core snapshot", () => {
  const signatures = createHelpSignatures(snapshot);
  expect(Object.keys(signatures)).toEqual(apiEntries.map((entry) => entry.id));
  for (const entry of apiEntries) {
    expect(signatures[entry.id]!.length, entry.name).toBeGreaterThan(0);
    for (const signature of signatures[entry.id]!) {
      expect(signature.label, entry.name).not.toMatch(/: any$|loadVec|storeVec/);
      expect(signature.source, entry.name).toMatch(
        /^https:\/\/github.com\/yuichkun\/unworklet\/blob\/main\/(packages|skills)\//,
      );
    }
  }
  expect(signatures.clamp!.some((signature) => signature.label.includes("Node"))).toBe(true);
  expect(
    signatures["state.buffer.f32"]!.some((signature) => signature.label.includes("size")),
  ).toBe(true);
  expect(apiEntries.find((entry) => entry.name === "everyNSamples")!.scope).toBe(
    "Callback parameter",
  );
  expect(apiEntries.some((entry) => /SIMD|loadVec|storeVec/.test(entry.name))).toBe(false);
});

test("all ambient value names are either documented directly or as an explicit family", () => {
  const source = ts.createSourceFile("ambient.d.ts", AMBIENT_DTS, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    )
      names.push(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const name of names) {
    expect(
      apiEntries.some(
        (entry) =>
          entry.name === name || entry.name.startsWith(`${name}.`) || entry.aliases?.includes(name),
      ),
      name,
    ).toBe(true);
  }
});

test("each complete help example lowers from the browser snapshot and renders a finite main output", async () => {
  const entries = [...apiEntries, ...sugarEntries];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.example)) continue;
    seen.add(entry.example);
    const processor = lowerToProcessor(entry.example, snapshot);
    const rendered = await renderOffline(processor, { sampleRate: 48_000, duration: 128 / 48_000 });
    expect(rendered.outputs.main, entry.name).toBeDefined();
    expect(rendered.outputs.main![0]!.length, entry.name).toBe(128);
    expect(
      rendered.outputs.main!.every((channel) => channel.every(Number.isFinite)),
      entry.name,
    ).toBe(true);
    expect(rendered.diagnostics.scrubbedSamples, entry.name).toBe(0);
    if (entry.id === "clamp") expect(rendered.outputs.main![0]![0]).toBe(0.5);
    if (entry.id === "sin") expect(rendered.outputs.main![0]![0]).toBeCloseTo(Math.sin(0.25), 4);
  }
}, 120_000);

test.each(sugarEntries)("$name: shown core operations match real lower() output", (entry) => {
  const lowered = compact(lower(entry.example, { snapshot }));
  expect(entry.example).toContain(entry.before);
  for (const fragment of entry.after)
    expect(lowered, `${entry.name}: ${fragment}`).toContain(compact(fragment));
});

test.each(unsupportedExamples)("$name is rejected or remains outside DSP sugar", (entry) => {
  if (entry.error)
    expect(() => lower(entry.source, { snapshot })).toThrowError(
      expect.objectContaining({ id: entry.error }),
    );
  else expect(compact(lower(entry.source, { snapshot }))).toContain(compact(entry.unchanged!));
});
