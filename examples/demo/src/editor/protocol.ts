export type DiagnosticPhase = "syntax" | "type" | "lowering" | "compile" | "runtime";
export type EditorDiagnostic = {
  phase: DiagnosticPhase;
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  start?: number;
  length?: number;
};
export type EditorQuery = {
  uri: string;
  version: number;
  source: string;
  kind: "completion" | "hover" | "signature" | "diagnostics";
  offset: number;
};
export type EditorCompletion = {
  name: string;
  insertText: string;
  kind: string;
  sortText: string;
  start: number;
  length: number;
  source?: string;
};
export type EditorResult = {
  uri: string;
  version: number;
  completions?: EditorCompletion[];
  hover?: { text: string; documentation: string; start: number; length: number };
  signature?: {
    activeSignature: number;
    activeParameter: number;
    items: {
      label: string;
      documentation: string;
      parameters: { label: [number, number]; documentation: string }[];
    }[];
  };
  diagnostics?: EditorDiagnostic[];
};
export type WorkerRequest = EditorQuery & { id: number };
export type WorkerResponse = { id: number; result?: EditorResult; error?: string };
