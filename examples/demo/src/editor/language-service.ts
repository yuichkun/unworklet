import { createLanguage, isSignatureHelpEnabled, type SourceScript } from "@volar/language-core";
import { resolveFileLanguageId } from "@volar/typescript/lib/common.js";
import { createProxyLanguageService } from "@volar/typescript/lib/node/proxyLanguageService.js";
import { decorateLanguageServiceHost } from "@volar/typescript/lib/node/decorateLanguageServiceHost.js";
import { getServiceScript } from "@volar/typescript/lib/node/utils.js";
import { toGeneratedOffset } from "@volar/typescript/lib/node/transform.js";
import ts from "typescript";

import { AMBIENT_DTS } from "../../../../packages/lang/src/ambient.ts";
import { createUwkLanguagePlugin } from "../../../../packages/lang/src/ide/languagePlugin.ts";
import { lower } from "../../../../packages/lang/src/lower.ts";
import { COMPILER_OPTIONS, type FsSnapshot } from "../../../../packages/lang/src/program.ts";
import { diagnosticFromError } from "./diagnostics.ts";
import type { EditorDiagnostic, EditorQuery, EditorResult } from "./protocol.ts";

const display = (parts: ts.SymbolDisplayPart[] | undefined) => ts.displayPartsToString(parts);

export function createEditorLanguageService(snapshot: FsSnapshot) {
  const fileName = `${snapshot.selfDir}/__editor__.uwk.ts`;
  const ambientName = `${snapshot.selfDir}/__uwk_ambient__.d.ts`;
  let source = "";
  let version = 0;
  const readFile = (name: string) =>
    name === fileName ? source : name === ambientName ? AMBIENT_DTS : snapshot.sourceTexts[name];
  const snapshots = new Map<string, ts.IScriptSnapshot>();
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => COMPILER_OPTIONS,
    getScriptFileNames: () => [ambientName, fileName],
    getProjectVersion: () => String(version),
    getScriptVersion: (name) => (name === fileName ? String(version) : "0"),
    getScriptSnapshot: (name) => {
      const text = readFile(name);
      if (text === undefined) return undefined;
      let value = snapshots.get(name);
      if (!value) {
        value = ts.ScriptSnapshot.fromString(text);
        snapshots.set(name, value);
      }
      return value;
    },
    getCurrentDirectory: () => snapshot.currentDirectory,
    getDefaultLibFileName: () => snapshot.defaultLibFileName,
    fileExists: (name) => readFile(name) !== undefined || (snapshot.fileExists[name] ?? false),
    readFile,
    readDirectory: () => [],
    directoryExists: (name) => snapshot.dirExists[name] ?? false,
    getDirectories: (name) => snapshot.dirs[name] ?? [],
    realpath: (name) => snapshot.realpath[name] ?? name,
    useCaseSensitiveFileNames: () => snapshot.useCaseSensitiveFileNames,
  };
  const getSnapshot = host.getScriptSnapshot.bind(host);
  const language = createLanguage<string>(
    [createUwkLanguagePlugin(ts, { snapshot }), { getLanguageId: resolveFileLanguageId }],
    new Map<string, SourceScript<string>>(),
    (name) => {
      const text = getSnapshot(name);
      if (text) language.scripts.set(name, text);
      else language.scripts.delete(name);
    },
  );
  decorateLanguageServiceHost(ts, language, host);
  const rawService = ts.createLanguageService(host);
  const proxied = createProxyLanguageService(rawService);
  proxied.initialize(language);
  const ls = proxied.proxy;

  function diagnostics(): EditorDiagnostic[] {
    // A generated module suffix may absorb an unfinished call or hide an EOF error.
    // Parse syntax in author text; semantic checks still use the mapped virtual code.
    const parsed = ts.createSourceFile(
      fileName,
      source,
      ts.ScriptTarget.Latest,
      true,
    ) as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] };
    const syntax = parsed.parseDiagnostics;
    const map = (d: ts.Diagnostic, phase: "syntax" | "type"): EditorDiagnostic => ({
      phase,
      severity:
        d.category === ts.DiagnosticCategory.Error
          ? "error"
          : d.category === ts.DiagnosticCategory.Warning
            ? "warning"
            : "info",
      code: `TS${d.code}`,
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
      ...(d.start !== undefined &&
      d.length !== undefined &&
      d.start >= 0 &&
      d.start + d.length <= source.length
        ? { start: d.start, length: d.length }
        : {}),
    });
    const result = [
      ...syntax.map((d) => map(d, "syntax")),
      ...ls.getSemanticDiagnostics(fileName).map((d) => map(d, "type")),
    ];
    if (!result.length) {
      try {
        lower(source, { snapshot });
      } catch (error) {
        result.push(diagnosticFromError(error, "lowering", source.length));
      }
    }
    return result;
  }

  function signatureAt(offset: number): ts.SignatureHelpItems | undefined {
    const [script, target, author] = getServiceScript(language, fileName);
    if (!script || !target) return undefined;
    const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
    let activeCall: ts.CallExpression | undefined;
    const onlyTrivia = (text: string) =>
      ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text).scan() ===
      ts.SyntaxKind.EndOfFileToken;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.arguments.pos <= offset) {
        const last = node.getChildren(parsed).at(-1)!;
        const closed = last.kind === ts.SyntaxKind.CloseParenToken;
        if (
          offset <= (closed ? last.getStart(parsed) : node.arguments.end) ||
          (!closed && offset >= node.end && onlyTrivia(source.slice(node.end, offset)))
        )
          activeCall = node;
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    if (!activeCall) return undefined;
    const toGenerated = (position: number) =>
      toGeneratedOffset(language, script, author, position, isSignatureHelpEnabled);
    const argumentStart = toGenerated(activeCall.arguments.pos);
    if (argumentStart === undefined) return undefined;
    let generatedOffset = toGenerated(offset);
    for (
      let position = offset - 1;
      generatedOffset === undefined && position >= activeCall.arguments.pos;
      position -= 1
    )
      generatedOffset = toGenerated(position);
    if (generatedOffset === undefined) return undefined;
    const getAt = (position: number) =>
      rawService.getSignatureHelpItems(target.id, position, undefined);
    const info = getAt(generatedOffset);
    if (info?.applicableSpan.start === argumentStart) return info;
    const seeds = [generatedOffset];
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      true,
      ts.LanguageVariant.Standard,
      source.slice(0, offset),
    );
    let tokenEnd = offset;
    while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) tokenEnd = scanner.getTextPos();
    const tokenOffset = toGenerated(tokenEnd);
    if (tokenOffset !== undefined && tokenOffset !== generatedOffset) seeds.push(tokenOffset);
    const generated = rawService.getProgram()!.getSourceFile(target.id)!.text;
    // Sugar adds closing delimiters that have no authored call. Query on the
    // other side only when TypeScript's argument span identifies the same
    // authored call, preserving overload resolution and the active parameter.
    for (const seed of seeds) {
      const direct = getAt(seed);
      if (direct?.applicableSpan.start === argumentStart) return direct;
      for (const direction of [-1, 1]) {
        let position = seed;
        while (position >= 0 && position <= generated.length) {
          let character = generated[direction === -1 ? position - 1 : position];
          if (character === undefined || !/[\s)\]}]/.test(character)) break;
          if (/\s/.test(character)) {
            do {
              position += direction;
              character = generated[direction === -1 ? position - 1 : position];
            } while (character !== undefined && /\s/.test(character));
          } else position += direction;
          const candidate = getAt(position);
          if (candidate?.applicableSpan.start === argumentStart) return candidate;
        }
      }
    }
    return undefined;
  }

  return {
    query(query: EditorQuery): EditorResult {
      if (source !== query.source) {
        source = query.source;
        version += 1;
        snapshots.delete(fileName);
      }
      const result: EditorResult = { uri: query.uri, version: query.version };
      if (query.kind === "diagnostics") result.diagnostics = diagnostics();
      if (query.kind === "hover") {
        const info = ls.getQuickInfoAtPosition(fileName, query.offset);
        if (info)
          result.hover = {
            text: display(info.displayParts),
            documentation: display(info.documentation),
            ...info.textSpan,
          };
      }
      if (query.kind === "completion") {
        const info = ls.getCompletionsAtPosition(fileName, query.offset, {
          includeCompletionsForModuleExports: false,
          includeCompletionsWithInsertText: true,
        });
        const prefix = source.slice(0, query.offset).match(/[\w$]*$/)![0];
        result.completions = (info?.entries ?? [])
          .filter(
            (entry) =>
              !entry.source && !entry.name.startsWith("__uwk") && !entry.name.startsWith("__prev"),
          )
          .map((entry) => ({
            name: entry.name,
            insertText: entry.insertText ?? entry.name,
            kind: entry.kind,
            sortText: entry.sortText,
            ...(entry.replacementSpan ??
              info?.optionalReplacementSpan ?? {
                start: query.offset - prefix.length,
                length: prefix.length,
              }),
          }));
      }
      if (query.kind === "signature") {
        const info = signatureAt(query.offset);
        if (info)
          result.signature = {
            activeSignature: info.selectedItemIndex,
            activeParameter: info.argumentIndex,
            items: info.items.map((item) => {
              let label = display(item.prefixDisplayParts);
              const parameters = item.parameters.map((parameter, index) => {
                if (index) label += display(item.separatorDisplayParts);
                const start = label.length;
                label += display(parameter.displayParts);
                return {
                  label: [start, label.length] as [number, number],
                  documentation: display(parameter.documentation),
                };
              });
              label += display(item.suffixDisplayParts);
              return { label, parameters, documentation: display(item.documentation) };
            }),
          };
      }
      return result;
    },
    dispose: () => ls.dispose(),
  };
}
