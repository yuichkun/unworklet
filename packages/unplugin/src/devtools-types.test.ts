import { expect, test } from "vite-plus/test";
import path from "node:path";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { DevMidiInject, DevMidiInjectCommand } from "./index.ts";

test("the published MIDI command types remain constructible without internal page routing fields", () => {
  const command: DevMidiInjectCommand = {
    seq: 1,
    nodeId: "n0",
    port: "in",
    event: { type: "noteOn", channel: 0, note: 60, velocity: 100 },
  };
  const queue: DevMidiInject = { commands: [command] };
  expect(queue.commands).toEqual([command]);
});

test("published shared-state keys retain their original raw snapshot and queue shapes", () => {
  const states: Pick<
    import("@vitejs/devtools-kit").DevToolsRpcSharedStates,
    | "unworklet:graph"
    | "unworklet:state"
    | "unworklet:signals"
    | "unworklet:midi"
    | "unworklet:midi-inject"
  > = {
    "unworklet:graph": { nodes: [], edges: [] },
    "unworklet:state": { nodes: [] },
    "unworklet:signals": {
      nodes: [],
      context: { sampleRate: 0, baseLatencyMs: 0, outputLatencyMs: 0 },
    },
    "unworklet:midi": { ports: [], log: [] },
    "unworklet:midi-inject": {
      commands: [
        {
          seq: 1,
          nodeId: "n0",
          port: "in",
          event: { type: "noteOn", channel: 0, note: 60, velocity: 100 },
        },
      ],
    },
  };
  expect(states["unworklet:graph"].nodes).toEqual([]);
  expect(states["unworklet:midi-inject"].commands).toHaveLength(1);
});

test("a consumer using the public DevTools type entry can type documented client calls", () => {
  const file = path.join(import.meta.dirname, "devtools-consumer.type-fixture.ts");
  const source = readFileSync(new URL("./devtools-consumer.ts.txt", import.meta.url), "utf8")
    .replace('"@unworklet/unplugin"', '"./index.ts"')
    .replace('"@unworklet/unplugin/devtools"', '"../devtools.d.ts"');
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, ...rest) =>
    name === file
      ? ts.createSourceFile(name, source, languageVersion, true)
      : getSourceFile(name, languageVersion, ...rest);
  const program = ts.createProgram([file], options, host);
  const errors = ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file?.fileName === file);
  expect(
    errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
  ).toEqual([]);
}, 30_000);
