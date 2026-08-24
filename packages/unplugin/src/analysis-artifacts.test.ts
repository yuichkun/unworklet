/**
 * Contract of the analysis-artifact size gate (issue #40): a single artifact
 * past the cap — in practice the unrolled graph DAG — is skipped (reported by
 * name and size), while the small useful artifacts still ship.
 */

import { expect, test } from "vite-plus/test";

import { ANALYSIS_ARTIFACT_MAX_BYTES, partitionAnalysisArtifacts } from "./analysis-artifacts.ts";

test("artifacts under the cap all emit; nothing is skipped", () => {
  const { emit, skipped } = partitionAnalysisArtifacts([
    { name: "a.graph.json", source: "{}" },
    { name: "a.memory.json", source: "{}" },
  ]);
  expect(emit.map((a) => a.name)).toEqual(["a.graph.json", "a.memory.json"]);
  expect(skipped).toEqual([]);
});

test("an artifact past the cap is skipped by name+size while the rest emit", () => {
  const giant = "x".repeat(ANALYSIS_ARTIFACT_MAX_BYTES + 1);
  const { emit, skipped } = partitionAnalysisArtifacts([
    { name: "a.graph.json", source: giant },
    { name: "a.memory.json", source: "{}" },
  ]);
  expect(emit.map((a) => a.name)).toEqual(["a.memory.json"]);
  expect(skipped).toEqual([{ name: "a.graph.json", bytes: ANALYSIS_ARTIFACT_MAX_BYTES + 1 }]);
});

test("exactly at the cap still emits (the cap is a limit, not a fence-post trap)", () => {
  const atCap = "x".repeat(ANALYSIS_ARTIFACT_MAX_BYTES);
  const { emit, skipped } = partitionAnalysisArtifacts([{ name: "a.graph.json", source: atCap }]);
  expect(emit.length).toBe(1);
  expect(skipped).toEqual([]);
});
