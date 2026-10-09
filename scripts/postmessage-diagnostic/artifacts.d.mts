import type { TransformRecord } from "./instrument.mjs";

export function createArtifactSink(
  output: string | undefined,
  manifest: Record<string, unknown>,
): {
  start(): void;
  recordTransform(record: TransformRecord): void;
  write(result: unknown): void;
  finish(result: {
    reason: string;
    errors?: readonly unknown[];
    moduleStates?: readonly string[];
    caseResult?: { state: string; errors?: readonly unknown[] } | null;
    collection?: { modules: number; tests: number; target: number; results: number } | null;
    secondaryExportFailure?: unknown;
  }): { traceStatus: string };
};
