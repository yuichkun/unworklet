import type { DiagnosticPhase, EditorDiagnostic } from "./protocol.ts";

function errorMessage(error: unknown, object: Record<string, unknown> | undefined): string {
  if (error instanceof Error) return error.message;
  if (typeof object?.message === "string") return object.message;
  if (object) {
    try {
      return JSON.stringify(object, null, 2) ?? "Unserializable error details";
    } catch {
      return "Unserializable error details";
    }
  }
  return String(error);
}

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
    message: errorMessage(error, object),
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
