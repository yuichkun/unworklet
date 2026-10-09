import type { createArtifactSink } from "./artifacts.mjs";

export function getDiagnosticSession(
  output: string | undefined,
  settings: Record<string, unknown>,
): { readonly runId: string; readonly sink: ReturnType<typeof createArtifactSink> };
