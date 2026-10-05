import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import { EditorWorkerClient } from "./worker-client.ts";
import type { EditorDiagnostic } from "./protocol.ts";

export function sourceRange(
  model: monaco.editor.ITextModel,
  start: number,
  length: number,
): monaco.Range {
  const from = model.getPositionAt(start);
  const to = model.getPositionAt(start + length);
  return new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column);
}

export function setDiagnostics(
  model: monaco.editor.ITextModel,
  owner: string,
  diagnostics: EditorDiagnostic[],
): void {
  monaco.editor.setModelMarkers(
    model,
    owner,
    diagnostics.flatMap((diagnostic) => {
      if (diagnostic.start === undefined || diagnostic.length === undefined) return [];
      const range = sourceRange(model, diagnostic.start, diagnostic.length);
      return [
        {
          startLineNumber: range.startLineNumber,
          startColumn: range.startColumn,
          endLineNumber: range.endLineNumber,
          endColumn: range.endColumn,
          message: `[${diagnostic.phase}] ${diagnostic.message}`,
          code: diagnostic.code,
          source: "unworklet",
          severity:
            diagnostic.severity === "error"
              ? monaco.MarkerSeverity.Error
              : diagnostic.severity === "warning"
                ? monaco.MarkerSeverity.Warning
                : monaco.MarkerSeverity.Info,
        },
      ];
    }),
  );
}

export function attachEditorAssistance(
  model: monaco.editor.ITextModel,
  update: (diagnostics: EditorDiagnostic[], status: string) => void,
  createWorker: () => Worker = () =>
    new Worker(new URL("./language.worker.ts", import.meta.url), { type: "module" }),
): { dispose(): void } {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failed = false;
  let client: EditorWorkerClient;
  const fail = (message: string, permanent = true) => {
    failed = permanent;
    setDiagnostics(model, "uwk-live", []);
    update([], message);
  };
  try {
    client = new EditorWorkerClient(createWorker(), fail);
  } catch {
    fail("Editor assistance could not start. You can keep editing and recompile.");
    return { dispose() {} };
  }
  const sync = () =>
    client.update({
      uri: model.uri.toString(),
      version: model.getVersionId(),
      source: model.getValue(),
    });
  const query: EditorWorkerClient["query"] = (...args) => {
    sync();
    return client.query(...args);
  };
  const kinds = monaco.languages.CompletionItemKind;
  const completionKind = (kind: string) => {
    if (kind === "function" || kind === "local function") return kinds.Function;
    if (kind === "method") return kinds.Method;
    if (kind === "property" || kind === "getter" || kind === "setter") return kinds.Property;
    if (kind === "keyword") return kinds.Keyword;
    if (kind === "type" || kind === "interface") return kinds.Interface;
    return kinds.Variable;
  };
  const providers = [
    monaco.languages.registerCompletionItemProvider("typescript", {
      triggerCharacters: ["."],
      async provideCompletionItems(current, position, _context, token) {
        if (current !== model) return undefined;
        const result = await query("completion", model.getOffsetAt(position), token);
        if (!result || disposed) return undefined;
        return {
          suggestions: (result.completions ?? []).map((item) => ({
            label: item.name,
            insertText: item.insertText,
            kind: completionKind(item.kind),
            sortText: item.sortText,
            range: sourceRange(model, item.start, item.length),
          })),
        };
      },
    }),
    monaco.languages.registerHoverProvider("typescript", {
      async provideHover(current, position, token) {
        if (current !== model) return undefined;
        const result = await query("hover", model.getOffsetAt(position), token);
        const info = result?.hover;
        if (!info || disposed) return undefined;
        return {
          range: sourceRange(model, info.start, info.length),
          contents: [
            { value: `\`\`\`typescript\n${info.text}\n\`\`\`` },
            ...(info.documentation ? [{ value: info.documentation }] : []),
          ],
        };
      },
    }),
    monaco.languages.registerSignatureHelpProvider("typescript", {
      signatureHelpTriggerCharacters: ["(", ","],
      signatureHelpRetriggerCharacters: [")"],
      async provideSignatureHelp(current, position, token) {
        if (current !== model) return undefined;
        const result = await query("signature", model.getOffsetAt(position), token);
        const info = result?.signature;
        if (!info || disposed) return undefined;
        return {
          value: {
            signatures: info.items,
            activeSignature: info.activeSignature,
            activeParameter: info.activeParameter,
          },
          dispose() {},
        };
      },
    }),
  ];
  const schedule = () => {
    clearTimeout(timer);
    sync();
    setDiagnostics(model, "uwk-live", []);
    if (failed) return;
    update([], "Checking source…");
    timer = setTimeout(async () => {
      const result = await query("diagnostics", 0);
      if (!result || disposed) return;
      const diagnostics = result.diagnostics ?? [];
      setDiagnostics(model, "uwk-live", diagnostics);
      update(
        diagnostics,
        diagnostics.length
          ? `${diagnostics.length} source issue${diagnostics.length === 1 ? "" : "s"}`
          : "No static issues. Recompile to apply changes.",
      );
    }, 400);
  };
  const change = model.onDidChangeContent(schedule);
  schedule();
  update([], "Loading editor assistance…");
  return {
    dispose() {
      disposed = true;
      clearTimeout(timer);
      change.dispose();
      providers.forEach((provider) => provider.dispose());
      client.dispose();
      setDiagnostics(model, "uwk-live", []);
    },
  };
}
