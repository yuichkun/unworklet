/**
 * Build-time analysis artifact gating (issue #40).
 *
 * The graph JSON is the processor's whole expression DAG: build-time-unrolled
 * loops (taps / voices / feedback lines) multiply it far past the app itself —
 * a ~270 MB `graph.json` landing in `dist/` was measured in the wild, shipped
 * by any pipeline that deploys `dist/` wholesale. Artifacts are therefore
 * opt-in (`emitAnalysisArtifacts: true`), and even opted-in, any single
 * artifact past the cap is skipped with a warning instead of dominating the
 * bundle.
 *
 * The cap is charged AS the value is walked, not against a finished string: a
 * DAG that cannot fit is never materialized, so an opt-in build does not pay
 * the peak memory and the stall that the cap exists to avoid. The charge is a
 * running estimate — key and string lengths plus a fixed per-entry cost for
 * punctuation and indentation — so an artifact within a small factor of the cap
 * may fall on either side of it. That is the intended precision: the cap
 * separates KB-sized artifacts from a runaway DAG, not 8.0 MB from 8.1 MB.
 */

export type AnalysisArtifact = { name: string; source: string };

/** Per-artifact size cap. Generous for the useful artifacts (memory /
 * diagnostics / schema-hash are KBs); only a pathological graph DAG hits it. */
export const ANALYSIS_ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;

/** Thrown out of the replacer to abandon a serialization past its budget. */
const CAP_EXCEEDED = Symbol("unworklet.analysis-artifact-cap");

/** Punctuation, newline and indentation charged for each entry walked. */
const PER_ENTRY_OVERHEAD = 8;

/** Pretty JSON for `value`, or null once the walk has spent its budget. */
function serializeUnderCap(value: unknown): string | null {
  let budget = ANALYSIS_ARTIFACT_MAX_BYTES;
  try {
    const json = JSON.stringify(
      value,
      (key: string, entry: unknown): unknown => {
        budget -= key.length + PER_ENTRY_OVERHEAD;
        if (typeof entry === "string") budget -= entry.length + 2;
        if (budget < 0) throw CAP_EXCEEDED;
        // A bigint has no JSON form; the DSL uses it for i64 slot values.
        return typeof entry === "bigint" ? `${entry}n` : entry;
      },
      2,
    );
    return `${json}\n`;
  } catch (err) {
    if (err === CAP_EXCEEDED) return null;
    throw err;
  }
}

export function partitionAnalysisArtifacts(
  artifacts: ReadonlyArray<{ name: string; value: unknown }>,
): {
  emit: AnalysisArtifact[];
  skipped: Array<{ name: string }>;
} {
  const emit: AnalysisArtifact[] = [];
  const skipped: Array<{ name: string }> = [];
  for (const artifact of artifacts) {
    const source = serializeUnderCap(artifact.value);
    if (source === null) skipped.push({ name: artifact.name });
    else emit.push({ name: artifact.name, source });
  }
  return { emit, skipped };
}
