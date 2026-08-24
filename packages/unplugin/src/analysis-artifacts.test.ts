/**
 * Contract of the analysis-artifact size gate (issue #40): a single artifact
 * past the cap — in practice the unrolled graph DAG — is skipped by name while
 * the small useful artifacts still ship. The cap is charged AS the value is
 * serialized, so an artifact that cannot fit is never built in full.
 */

import { expect, test } from "vite-plus/test";

import { ANALYSIS_ARTIFACT_MAX_BYTES, partitionAnalysisArtifacts } from "./analysis-artifacts.ts";

test("artifacts under the cap all emit, serialized as pretty JSON", () => {
  const { emit, skipped } = partitionAnalysisArtifacts([
    { name: "a.graph.json", value: { kind: "graph" } },
    { name: "a.memory.json", value: { totalBytes: 512 } },
  ]);
  expect(emit.map((a) => a.name)).toEqual(["a.graph.json", "a.memory.json"]);
  expect(emit[0]!.source).toBe('{\n  "kind": "graph"\n}\n');
  expect(skipped).toEqual([]);
});

test("a bigint is encoded rather than throwing the serializer", () => {
  const { emit } = partitionAnalysisArtifacts([{ name: "a.graph.json", value: { seed: 9n } }]);
  expect(emit[0]!.source).toBe('{\n  "seed": "9n"\n}\n');
});

test("an artifact past the cap is skipped by name while the rest emit", () => {
  const giant = { blob: "x".repeat(ANALYSIS_ARTIFACT_MAX_BYTES + 1) };
  const { emit, skipped } = partitionAnalysisArtifacts([
    { name: "a.graph.json", value: giant },
    { name: "a.memory.json", value: { totalBytes: 512 } },
  ]);
  expect(emit.map((a) => a.name)).toEqual(["a.memory.json"]);
  expect(skipped.map((s) => s.name)).toEqual(["a.graph.json"]);
});

test("an oversized artifact stops being serialized instead of being measured afterwards", () => {
  // The graph DAG reaches hundreds of MB on a loop-heavy processor. Measuring
  // the finished string still pays the peak memory and the stall the cap exists
  // to avoid, so the walk has to stop once the budget is gone.
  let touched = 0;
  const chunk = "x".repeat(4096);
  const items = Array.from({ length: 8000 }, () => ({
    get payload(): string {
      touched++;
      return chunk;
    },
  }));
  const { emit, skipped } = partitionAnalysisArtifacts([
    { name: "a.graph.json", value: { items } },
  ]);
  expect(emit).toEqual([]);
  expect(skipped.map((s) => s.name)).toEqual(["a.graph.json"]);
  // ~32 MB of payload against an 8 MB cap: a full walk would touch all 8000.
  expect(touched).toBeLessThan(items.length / 2);
});
