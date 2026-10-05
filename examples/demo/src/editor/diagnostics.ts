import type { DiagnosticPhase, EditorDiagnostic } from "./protocol.ts";

export function diagnosticFromError(
  error: unknown,
  phase: DiagnosticPhase,
  sourceLength: number,
): EditorDiagnostic {
  const object =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : undefined;
  const range =
    typeof object?.sourceRange === "object" && object.sourceRange !== null
      ? (object.sourceRange as Record<string, unknown>)
      : undefined;
  const start = range?.start;
  const length = range?.length;
  return {
    phase,
    severity: "error",
    code:
      typeof object?.id === "string"
        ? object.id
        : typeof object?.code === "string"
          ? object.code
          : phase,
    message:
      error instanceof Error
        ? error.message
        : typeof object?.message === "string"
          ? object.message
          : String(error),
    ...(phase !== "runtime" &&
    typeof start === "number" &&
    typeof length === "number" &&
    Number.isInteger(start) &&
    Number.isInteger(length) &&
    start >= 0 &&
    length >= 0 &&
    start + length <= sourceLength
      ? { start, length }
      : {}),
  };
}
