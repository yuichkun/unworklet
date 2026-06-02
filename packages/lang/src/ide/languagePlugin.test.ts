/**
 * End-to-end IDE behavior over a headless Volar TypeScript language service — the
 * exact pipeline an editor runs. A `.uwk.ts` fixture is type-checked through the
 * {@link createUwkLanguagePlugin} virtual code; every query (diagnostics, hover,
 * completion, go-to-definition) is issued at the AUTHOR's source position and the
 * result is projected back to source by Volar. These assertions are the proof that
 * the sugar "type-checks correctly in the IDE" without a `// @ts-nocheck` header.
 */

import { createLanguage, type SourceScript } from "@volar/language-core";
import {
  createProxyLanguageService,
  decorateLanguageServiceHost,
  resolveFileLanguageId,
} from "@volar/typescript";
import ts from "typescript";
import { expect, test } from "vite-plus/test";

import { AMBIENT_DTS } from "../ambient.ts";
import { createUwkLanguagePlugin } from "./languagePlugin.ts";

const DIR = import.meta.dirname;
const AMBIENT_PATH = `${DIR}/__uwk_ambient__.d.ts`;

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  lib: ["lib.es2023.d.ts"],
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  customConditions: ["development"],
  allowImportingTsExtensions: true,
  noEmit: true,
  skipLibCheck: true,
  strict: false,
  esModuleInterop: true,
};

// One Volar-decorated TS language service, built lazily and shared across the
// suite. It loads the lib + `@unworklet/core` type surface ONCE and serves every
// fixture as a distinct in-memory `.uwk.ts` file, so per-test cost is an
// incremental program update rather than a full type-environment reload — which
// keeps the suite fast enough not to starve the heavier snapshot tests under
// parallel coverage.
const fixtures = new Map<string, string>();
let projectVersion = 0;
let fixtureCounter = 0;

const sharedLs: ts.LanguageService = (() => {
  const snapshotText = (fileName: string): string | undefined =>
    fileName === AMBIENT_PATH ? AMBIENT_DTS : (fixtures.get(fileName) ?? ts.sys.readFile(fileName));
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => COMPILER_OPTIONS,
    getScriptFileNames: () => [AMBIENT_PATH, ...fixtures.keys()],
    getProjectVersion: () => String(projectVersion),
    getScriptVersion: () => "0",
    getScriptSnapshot: (fileName) => {
      const text = snapshotText(fileName);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => DIR,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: (fileName) =>
      fileName === AMBIENT_PATH || fixtures.has(fileName) || ts.sys.fileExists(fileName),
    readFile: (fileName) => snapshotText(fileName),
    readDirectory: (path, exts, exclude, include, depth) =>
      ts.sys.readDirectory(path, exts, exclude, include, depth),
    directoryExists: (dir) => ts.sys.directoryExists(dir),
    getDirectories: (dir) => ts.sys.getDirectories(dir),
    realpath: (p) => ts.sys.realpath?.(p) ?? p,
  };

  // Capture the UNDECORATED snapshot getter: `decorateLanguageServiceHost` wraps
  // `getScriptSnapshot` to route through the language, so the sync callback must
  // use the original or it recurses into the decoration forever.
  const getScriptSnapshot = host.getScriptSnapshot.bind(host);
  const language = createLanguage<string>(
    [createUwkLanguagePlugin(ts), { getLanguageId: resolveFileLanguageId }],
    new Map<string, SourceScript<string>>(),
    (fileName) => {
      const snapshot = getScriptSnapshot(fileName);
      if (snapshot) language.scripts.set(fileName, snapshot);
      else language.scripts.delete(fileName);
    },
  );
  decorateLanguageServiceHost(ts, language, host);
  const proxied = createProxyLanguageService(ts.createLanguageService(host));
  proxied.initialize(language);
  return proxied.proxy;
})();

/** Register `source` as a fresh `.uwk.ts` file in the shared service. */
function service(source: string): { ls: ts.LanguageService; fileName: string } {
  const fileName = `${DIR}/__fixture_${fixtureCounter++}__.uwk.ts`;
  fixtures.set(fileName, source);
  projectVersion += 1;
  return { ls: sharedLs, fileName };
}

type SimpleDiag = { message: string; span: string | undefined };

function diagnostics(source: string): SimpleDiag[] {
  const { ls, fileName } = service(source);
  return ls.getSemanticDiagnostics(fileName).map((d) => ({
    message: ts.flattenDiagnosticMessageText(d.messageText, " "),
    span:
      d.start !== undefined && d.length !== undefined
        ? source.slice(d.start, d.start + d.length)
        : undefined,
  }));
}

/** The 1-based offset of the FIRST occurrence of `needle`, plus an in-token nudge. */
function at(source: string, needle: string, nudge = 1): number {
  const i = source.indexOf(needle);
  if (i < 0) throw new Error(`needle not found: ${needle}`);
  return i + nudge;
}

// ───────────────────────── valid sugar → zero diagnostics ───────────────────

test("valid stereo-gain Tier B sugar reports NO diagnostics (no @ts-nocheck needed)", () => {
  const src = `const input = audioInput({ channels: 2 });
const out = audioOutput({ channels: 2 });
const gain = param.f32({ default: 1, min: 0, max: 4, automationRate: "a-rate" });
const meterL = state.f32(0).expose({ publish: { rateFps: 30 } });
process(() => {
  forSample((i) => {
    const l = input.left[i] * gain[i];
    out.left[i] = l;
    meterL.write(max(abs(l), meterL));
  });
  meterL.write(meterL * 0.95);
});`;
  expect(diagnostics(src)).toEqual([]);
});

test("valid MIDI synth (event.midi no-name, bare-state, .named(), select) reports NO diagnostics", () => {
  const src = `const out = audioOutput({ channels: 1, name: "main" });
const notes = event.midi({ from: "main" });
const phase = state.f32(0).named();
const note = state.i32(69).named();
const gate = state.bool(false).named();
process(() => {
  notes.onEvent("noteOn", ({ note: n }) => { note.write(n); gate.write(true); });
  forSample((i) => {
    const inc = f32(note).sub(69).mul(Math.LN2 / 12).exp().mul(440 / 48000);
    out.ch(0)[i] = sin(phase) * select(gate, 0.3, 0);
    phase.write(phase + inc);
  });
});`;
  expect(diagnostics(src)).toEqual([]);
});

test("index read/write + buffer + ternary + comparison sugar reports NO diagnostics", () => {
  const src = `const buf = state.buffer.f32({ size: 16 }).named();
const input = audioInput({ channels: 1, name: "main" });
const out = audioOutput({ channels: 1, name: "main" });
const head = state.i32(0).named();
process(() => {
  forSample((i) => {
    buf[head] = input.ch(0)[i];
    const v = buf[i] > 0 ? buf[i] * 0.5 : -buf[i];
    out.ch(0)[i] = v;
  });
});`;
  expect(diagnostics(src)).toEqual([]);
});

// ───────────────────────── real type errors surface, mapped to source ───────

test("assigning a bool Node to an f32 output channel is a mapped error on the value", () => {
  const src = `const gate = state.bool(false).named();
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = gate;
  });
});`;
  const diags = diagnostics(src);
  expect(diags.length).toBe(1);
  expect(diags[0]!.message).toContain('Node<"bool">');
  expect(diags[0]!.message).toContain('Node<"f32">');
  // The error projects back onto the author's `gate`, not into generated glue.
  expect(diags[0]!.span).toContain("gate");
});

test("calling a non-existent method on a Node is a mapped error", () => {
  const src = `const input = audioInput({ channels: 1, name: "main" });
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = input.ch(0)[i].notAMethod();
  });
});`;
  const diags = diagnostics(src);
  expect(diags.some((d) => d.message.includes("notAMethod"))).toBe(true);
});

test("a misspelled declaration identifier is a mapped error at the use site", () => {
  const src = `const input = audioInput({ channels: 1, name: "main" });
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = inputt.ch(0)[i] * 2;
  });
});`;
  const diags = diagnostics(src);
  expect(diags.some((d) => d.message.includes("inputt") && d.span === "inputt")).toBe(true);
});

// ───────────────────────── hover ────────────────────────────────────────────

test("hover on a sugar-multiplied binding reports its Node type", () => {
  const src = `const input = audioInput({ channels: 1, name: "main" });
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    const wet = input.ch(0)[i] * 2;
    out.ch(0)[i] = wet;
  });
});`;
  const { ls, fileName } = service(src);
  const info = ls.getQuickInfoAtPosition(fileName, at(src, "wet", 1));
  const display = info?.displayParts?.map((p) => p.text).join("") ?? "";
  expect(display).toContain("wet");
  expect(display).toContain('Node<"f32">');
});

test("hover on a declaration handle reports its DSL type", () => {
  const src = `const cutoff = param.f32({ default: 1, min: 0, max: 4, automationRate: "a-rate" });
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = cutoff[i];
  });
});`;
  const { ls, fileName } = service(src);
  // hover the `cutoff` use inside the process body
  const info = ls.getQuickInfoAtPosition(fileName, at(src, "cutoff[i]", 1));
  const display = info?.displayParts?.map((p) => p.text).join("") ?? "";
  expect(display).toContain("Param");
});

// ───────────────────────── completion ───────────────────────────────────────

test("completion after `input.` offers the stereo channel-view members", () => {
  const src = `const input = audioInput({ channels: 2 });
const out = audioOutput({ channels: 2 });
process(() => {
  forSample((i) => {
    out.left[i] = input.left[i];
  });
});`;
  const { ls, fileName } = service(src);
  // position right after the dot in the FIRST `input.left`
  const dot = src.indexOf("input.") + "input.".length;
  const completions = ls.getCompletionsAtPosition(fileName, dot, undefined);
  const names = completions?.entries.map((e) => e.name) ?? [];
  expect(names).toContain("left");
  expect(names).toContain("right");
  expect(names).toContain("ch");
});

// ───────────────────────── go to definition ─────────────────────────────────

test("go-to-definition on a sugar operand jumps to the declaration in source", () => {
  const src = `const gain = param.f32({ default: 1, min: 0, max: 4, automationRate: "a-rate" });
const out = audioOutput({ channels: 1, name: "main" });
const input = audioInput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = input.ch(0)[i] * gain[i];
  });
});`;
  const { ls, fileName } = service(src);
  const useOffset = src.lastIndexOf("gain[i]") + 1;
  const defs = ls.getDefinitionAtPosition(fileName, useOffset);
  expect(defs?.length).toBeGreaterThan(0);
  const def = defs![0]!;
  expect(def.fileName).toBe(fileName);
  // the definition span lands on the `gain` declaration binding (offset of `const gain`)
  expect(src.slice(def.textSpan.start, def.textSpan.start + def.textSpan.length)).toBe("gain");
  expect(def.textSpan.start).toBe(src.indexOf("const gain") + "const ".length);
});
