/**
 * Build-time analysis artifact gating (issue #40).
 *
 * The graph JSON is the processor's whole expression DAG: build-time-unrolled
 * loops (taps / voices / feedback lines) multiply it far past the app itself —
 * a ~270 MB `graph.json` landing in `dist/` was measured in the wild, shipped
 * by any pipeline that deploys `dist/` wholesale. Artifacts are therefore
 * opt-in (`emitAnalysisArtifacts: true`), and even opted-in, any single
 * artifact past the cap is skipped with a warning instead of silently
 * dominating the bundle.
 */

export type AnalysisArtifact = { name: string; source: string };

/** Per-artifact size cap. Generous for the useful artifacts (memory /
 * diagnostics / schema-hash are KBs); only a pathological graph DAG hits it. */
export const ANALYSIS_ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;

export function partitionAnalysisArtifacts(artifacts: readonly AnalysisArtifact[]): {
  emit: AnalysisArtifact[];
  skipped: Array<{ name: string; bytes: number }>;
} {
  const emit: AnalysisArtifact[] = [];
  const skipped: Array<{ name: string; bytes: number }> = [];
  for (const artifact of artifacts) {
    const bytes = Buffer.byteLength(artifact.source, "utf8");
    if (bytes > ANALYSIS_ARTIFACT_MAX_BYTES) skipped.push({ name: artifact.name, bytes });
    else emit.push(artifact);
  }
  return { emit, skipped };
}
