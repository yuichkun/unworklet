/**
 * `unworklet` Vite plugin factory shape + `?worklet` resolve / load hooks
 * (= `07-vite-plugin.md` + `10-roadmap.md` Phase 5)。 5-B = factory が real
 * Vite `Plugin` object を 返 す こ と + 5-C = `?worklet` query を 持 つ
 * source を virtual id に 解 決 + virtual id を 受 け た load が JS module
 * を 返 す こ と + 5-D = load 内 で source module を 動 的 import → fixture
 * processor を 取 り 出 し → `compile()` → `this.emitFile` で WASM asset
 * を emit、 戻 り 値 は `import.meta.ROLLUP_FILE_URL_<refId>` 形 で URL
 * substitution を 受 け る JS module。
 */

import { fileURLToPath } from "node:url";

import { compile } from "@unworklet/core";
import { expect, test, vi } from "vite-plus/test";

import unworklet, { unworkletPlugin } from "./index.ts";

type ResolveIdFn = (
  this: unknown,
  source: string,
  importer: string | undefined,
  options: { isEntry: boolean },
) => unknown;

type LoadFn = (this: unknown, id: string) => unknown;

type AssetEmit = { type: "asset"; name: string; source: Uint8Array | string };
type ChunkEmit = { type: "chunk"; id: string; name: string };
type EmitFileArgs = AssetEmit | ChunkEmit;

type MockEmitContext = {
  calls: EmitFileArgs[];
  refId: string;
  watched: string[];
  emitFile: (file: EmitFileArgs) => string;
  addWatchFile: (file: string) => void;
};

const assetCalls = (ctx: MockEmitContext): AssetEmit[] =>
  ctx.calls.filter((c): c is AssetEmit => c.type === "asset");

const makeMockEmitContext = (): MockEmitContext => {
  const ctx: MockEmitContext = {
    calls: [],
    refId: "mock-ref-id",
    watched: [],
    emitFile(file) {
      ctx.calls.push(file);
      return ctx.refId;
    },
    addWatchFile(file) {
      ctx.watched.push(file);
    },
  };
  return ctx;
};

const callResolveId = (source: string, importer: string | undefined): unknown => {
  const hook = unworklet().resolveId;
  if (typeof hook !== "function") {
    throw new Error("resolveId hook is not a function — expected plain function form");
  }
  return (hook as unknown as ResolveIdFn).call(null, source, importer, { isEntry: false });
};

const callLoadWithMockContext = async (
  id: string,
  options?: Parameters<typeof unworklet>[0],
): Promise<{ result: unknown; ctx: MockEmitContext }> => {
  const hook = unworklet(options).load;
  if (typeof hook !== "function") {
    throw new Error("load hook is not a function — expected plain function form");
  }
  const ctx = makeMockEmitContext();
  const result = await (hook as unknown as LoadFn).call(ctx, id);
  return { result, ctx };
};

type ConfigResolvedFn = (
  this: unknown,
  config: { command: string; root: string; base: string },
) => void;

const callLoadInServeMode = async (
  id: string,
  serveConfig: { root: string; base?: string } = { root: "/" },
): Promise<unknown> => {
  const plugin = unworklet();
  const configHook = plugin.configResolved;
  if (typeof configHook !== "function") {
    throw new Error("configResolved hook is not a function");
  }
  (configHook as unknown as ConfigResolvedFn).call(null, {
    command: "serve",
    root: serveConfig.root,
    base: serveConfig.base ?? "/",
  });
  const loadHook = plugin.load;
  if (typeof loadHook !== "function") {
    throw new Error("load hook is not a function");
  }
  const ctx = makeMockEmitContext();
  return await (loadHook as unknown as LoadFn).call(ctx, id);
};

const callLoadNoContext = async (id: string): Promise<unknown> => {
  const hook = unworklet().load;
  if (typeof hook !== "function") {
    throw new Error("load hook is not a function — expected plain function form");
  }
  // Even when the test does not care about emitFile, the plugin's load hook
  // may call `this.addWatchFile(...)` (= vite invalidation dependency)。
  // Provide a minimal mock context so those calls are no-ops。
  return await (hook as unknown as LoadFn).call(makeMockEmitContext(), id);
};

const NUL = String.fromCharCode(0);
const VIRTUAL_ID_PREFIX = `${NUL}unworklet:`;

const FIXTURE_GAIN_PATH = fileURLToPath(
  new URL("../__fixtures__/01-stereo-gain.processor.ts", import.meta.url),
);

const FIXTURE_NO_PROCESSOR_PATH = fileURLToPath(
  new URL("../__fixtures__/no-processor.processor.ts", import.meta.url),
);

const FIXTURE_MULTI_PROCESSOR_PATH = fileURLToPath(
  new URL("../__fixtures__/multi-processor.processor.ts", import.meta.url),
);

const FIXTURE_BARE_GAIN_PATH = fileURLToPath(
  new URL("../__fixtures__/bare-gain.ts", import.meta.url),
);

const FIXTURE_DUPLICATE_NAME_GAIN_PATH = fileURLToPath(
  new URL("../__fixtures__/01-stereo-gain-duplicate-name.processor.ts", import.meta.url),
);

/** `.uwk.ts` sugar equivalent of `01-stereo-gain.processor.ts` — same processor. */
const FIXTURE_UWK_GAIN_PATH = fileURLToPath(
  new URL("../__fixtures__/stereo-gain.uwk.ts", import.meta.url),
);

type TransformFn = (this: unknown, code: string, id: string) => unknown;

/** Invoke the plugin's `transform` hook with a context whose `error` throws. */
const callTransform = (code: string, id: string): unknown => {
  const hook = unworklet().transform;
  if (typeof hook !== "function") {
    throw new Error("transform hook is not a function — expected plain function form");
  }
  const ctx = {
    error: (msg: string): never => {
      throw new Error(msg);
    },
  };
  return (hook as unknown as TransformFn).call(ctx, code, id);
};

// ─────────────────────────────────────────────────────────────────────────
// 5-B = factory shape
// ─────────────────────────────────────────────────────────────────────────

test("`unworklet()` returns a Vite Plugin object with a stable name", () => {
  const plugin = unworklet();
  expect(plugin).toMatchObject({ name: "@unworklet/vite-plugin" });
});

test("`unworklet()` accepts an options bag without throwing", () => {
  expect(() => unworklet({})).not.toThrow();
  expect(() => unworklet({ emitAnalysisArtifacts: false })).not.toThrow();
  expect(() =>
    unworklet({ include: ["**/*.processor.ts"], exclude: ["**/node_modules/**"] }),
  ).not.toThrow();
});

test("`unworkletPlugin` is the same reference as the default export", () => {
  expect(unworkletPlugin).toBe(unworklet);
});

// ─────────────────────────────────────────────────────────────────────────
// 5-C = ?worklet resolveId
// ─────────────────────────────────────────────────────────────────────────

test("resolveId returns undefined for sources without a `?worklet` query", () => {
  expect(callResolveId("./foo.processor.ts", "/parent/main.ts")).toBeUndefined();
  expect(callResolveId("./foo.ts?other=1", "/parent/main.ts")).toBeUndefined();
  expect(callResolveId("react", undefined)).toBeUndefined();
});

test("resolveId encodes a relative `?worklet` source against the importer", () => {
  const id = callResolveId("./foo.processor.ts?worklet", "/abs/parent/main.ts");
  expect(typeof id).toBe("string");
  expect((id as string).startsWith(VIRTUAL_ID_PREFIX)).toBe(true);
  expect(id as string).toContain("/abs/parent/foo.processor.ts");
});

test("resolveId preserves absolute `?worklet` source paths", () => {
  const id = callResolveId("/abs/foo.processor.ts?worklet", undefined);
  expect((id as string).startsWith(VIRTUAL_ID_PREFIX)).toBe(true);
  expect(id as string).toContain("/abs/foo.processor.ts");
});

test("resolveId accepts `?worklet` mixed with other query params", () => {
  const id = callResolveId("./foo.processor.ts?worklet&t=42", "/abs/parent/main.ts");
  expect((id as string).startsWith(VIRTUAL_ID_PREFIX)).toBe(true);
  expect(id as string).toContain("/abs/parent/foo.processor.ts");
});

test("resolveId leaves a relative source unresolved when no importer is given", () => {
  expect(callResolveId("./foo.processor.ts?worklet", undefined)).toBeUndefined();
});

// ─────────────────────────────────────────────────────────────────────────
// 5-D = load = dynamic import + compile + emitFile + URL substitution
// ─────────────────────────────────────────────────────────────────────────

test("load returns undefined for non-virtual ids", async () => {
  expect(await callLoadNoContext("/abs/foo.processor.ts")).toBeUndefined();
  expect(await callLoadNoContext(`${NUL}vite:client`)).toBeUndefined();
  expect(await callLoadNoContext(`${NUL}other-prefix:/abs/x.ts`)).toBeUndefined();
});

test("load evaluates the fixture, compiles it, and emits the WASM as a build asset", async () => {
  const { ctx } = await callLoadWithMockContext(`${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`);

  const wasmCall = assetCalls(ctx).find((c) => c.name.endsWith(".wasm"));
  expect(wasmCall).toMatchObject({
    type: "asset",
    name: "01-stereo-gain.wasm",
  });
  expect(wasmCall!.source).toBeInstanceOf(Uint8Array);
});

test("emitted WASM bytes match the result of compile() invoked directly", async () => {
  const { ctx } = await callLoadWithMockContext(`${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`);

  const fixtureModule = (await import(FIXTURE_GAIN_PATH)) as Record<string, unknown>;
  const direct = await compile(fixtureModule["stereoGain"] as Parameters<typeof compile>[0]);

  const wasmCall = assetCalls(ctx).find((c) => c.name.endsWith(".wasm"));
  const emitted = wasmCall!.source as Uint8Array;
  expect(emitted.byteLength).toBe(direct.wasm.byteLength);
  expect(Buffer.from(emitted).equals(Buffer.from(direct.wasm))).toBe(true);
});

test("load returns a JS module that defers the URL through ROLLUP_FILE_URL_<refId>", async () => {
  const { result, ctx } = await callLoadWithMockContext(`${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`);

  expect(typeof result).toBe("string");
  expect(result as string).toContain(`import.meta.ROLLUP_FILE_URL_${ctx.refId}`);
  expect(result as string).toMatch(/export default/);
});

test("load throws when the source has no defineProcessor exports", async () => {
  await expect(
    callLoadWithMockContext(`${VIRTUAL_ID_PREFIX}${FIXTURE_NO_PROCESSOR_PATH}`),
  ).rejects.toThrow(/no defineProcessor exports/);
});

test("load throws when the source has multiple defineProcessor exports", async () => {
  await expect(
    callLoadWithMockContext(`${VIRTUAL_ID_PREFIX}${FIXTURE_MULTI_PROCESSOR_PATH}`),
  ).rejects.toThrow(/multiple defineProcessor exports/);
});

test("emitted asset name omits the `.processor` suffix when present and keeps the base otherwise", async () => {
  const { ctx: gainCtx } = await callLoadWithMockContext(
    `${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`,
  );
  expect(assetCalls(gainCtx).find((c) => c.name.endsWith(".wasm"))).toMatchObject({
    name: "01-stereo-gain.wasm",
  });

  const { ctx: bareCtx } = await callLoadWithMockContext(
    `${VIRTUAL_ID_PREFIX}${FIXTURE_BARE_GAIN_PATH}`,
  );
  expect(assetCalls(bareCtx).find((c) => c.name.endsWith(".wasm"))).toMatchObject({
    name: "bare-gain.wasm",
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5-E = 4 metadata artifact JSON emit
// ─────────────────────────────────────────────────────────────────────────

test("load also emits 4 metadata artifact JSON files + the worklet entry chunk by default", async () => {
  const { ctx } = await callLoadWithMockContext(`${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`);

  const names = ctx.calls.map((c) => c.name).sort((a, b) => a.localeCompare(b));
  expect(names).toEqual([
    "01-stereo-gain.diagnostics.json",
    "01-stereo-gain.graph.json",
    "01-stereo-gain.memory.json",
    "01-stereo-gain.schema-hash.json",
    "01-stereo-gain.wasm",
    "01-stereo-gain.worklet",
  ]);
});

test("each emitted metadata JSON file parses to a valid JSON value", async () => {
  const { ctx } = await callLoadWithMockContext(`${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`);

  const findAsset = (n: string): AssetEmit => {
    const hit = assetCalls(ctx).find((c) => c.name === n);
    if (!hit) throw new Error(`asset not emitted: ${n}`);
    return hit;
  };
  expect(() => JSON.parse(findAsset("01-stereo-gain.graph.json").source as string)).not.toThrow();
  expect(() => JSON.parse(findAsset("01-stereo-gain.memory.json").source as string)).not.toThrow();
  expect(() =>
    JSON.parse(findAsset("01-stereo-gain.diagnostics.json").source as string),
  ).not.toThrow();
  const sh = JSON.parse(findAsset("01-stereo-gain.schema-hash.json").source as string) as {
    schemaHash: unknown;
  };
  expect(typeof sh.schemaHash).toBe("string");
});

test("load emits a worklet entry chunk pointing at the user source", async () => {
  const { ctx } = await callLoadWithMockContext(`${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`);

  const chunk = ctx.calls.find((c) => c.type === "chunk");
  expect(chunk).toMatchObject({
    type: "chunk",
    id: `\0unworklet-worklet:${FIXTURE_GAIN_PATH}`,
    name: "01-stereo-gain.worklet",
  });
});

test("load returns JS that augments the processor with moduleUrl / wasmUrl / processorName", async () => {
  const { result } = await callLoadWithMockContext(`${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`);

  expect(typeof result).toBe("string");
  const js = result as string;
  expect(js).toContain("moduleUrl:");
  expect(js).toContain("wasmUrl:");
  // Processor name = `<exportName>__<sha8(absSourcePath)>__<sha8(wasm)>` so
  // unrelated files that share an export identifier do not collide AND a
  // new revision of the same source registers under a new name (= forward-
  // compat with HMR / replaceProcessor)。
  expect(js).toMatch(/processorName:\s*"stereoGain__[0-9a-f]{8}__[0-9a-f]{8}"/);
  // displayName = the clean export name (no hash), what tools show instead of
  // the hashed registration key.
  expect(js).toMatch(/displayName:\s*"stereoGain"/);
});

test("two source files exporting the same identifier get distinct processorName suffixes", async () => {
  const { result: aResult } = await callLoadWithMockContext(
    `${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`,
  );
  const { result: bResult } = await callLoadWithMockContext(
    `${VIRTUAL_ID_PREFIX}${FIXTURE_DUPLICATE_NAME_GAIN_PATH}`,
  );
  const extract = (js: string): string => {
    const m = js.match(/processorName:\s*"([^"]+)"/);
    if (!m) throw new Error("processorName not found in augmented JS");
    return m[1]!;
  };
  const aName = extract(aResult as string);
  const bName = extract(bResult as string);
  expect(aName).toMatch(/^stereoGain__[0-9a-f]{8}__[0-9a-f]{8}$/);
  expect(bName).toMatch(/^stereoGain__[0-9a-f]{8}__[0-9a-f]{8}$/);
  expect(aName).not.toBe(bName);
});

test("augmented JS re-imports the original user source by absolute path", async () => {
  const { result } = await callLoadWithMockContext(`${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`);

  const js = result as string;
  expect(js).toContain(`from ${JSON.stringify(FIXTURE_GAIN_PATH)}`);
});

test("augmented JS exports both default + named (= export identifier matches user source)", async () => {
  const { result } = await callLoadWithMockContext(`${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`);

  const js = result as string;
  expect(js).toMatch(/export default/);
  expect(js).toContain("export { __unworkletAugmented as stereoGain }");
});

// ─────────────────────────────────────────────────────────────────────────
// `.uwk.ts` sugar lowering (Part 4) — transform hook + build-path lowering
// ─────────────────────────────────────────────────────────────────────────

const UWK_MINIMAL = `const out = audioOutput({ channels: 1, name: "main" });
process(() => {});`;

test("transform lowers a .uwk.ts source to a filename-derived named export", () => {
  const out = callTransform(UWK_MINIMAL, "/abs/synth.uwk.ts") as { code: string; map: null };
  expect(out.code).toContain("export const synth = defineProcessor(");
  expect(out.code).toContain('from "@unworklet/core"');
  expect(out.code).not.toContain("export default");
  expect(out.map).toBeNull();
});

test("transform returns undefined for a non-.uwk.ts id", () => {
  expect(callTransform("const x = 1;", "/abs/foo.ts")).toBeUndefined();
  expect(callTransform("const x = 1;", "/abs/bar.processor.ts")).toBeUndefined();
});

test("transform skips the plugin's own virtual id ending in .uwk.ts", () => {
  // The `\0unworklet:<source>` virtual module id ends in the source path (here
  // `.uwk.ts`), but its code is already-generated augmented JS — lowering it
  // would throw uwk-no-process. The `\0` guard must short-circuit it.
  expect(
    callTransform("export default __x;", `${VIRTUAL_ID_PREFIX}/abs/synth.uwk.ts`),
  ).toBeUndefined();
  expect(
    callTransform("export default __x;", `${NUL}unworklet-worklet:/abs/synth.uwk.ts`),
  ).toBeUndefined();
});

test("transform strips a query suffix before the .uwk.ts extension test", () => {
  const out = callTransform(UWK_MINIMAL, "/abs/synth.uwk.ts?t=123") as { code: string };
  expect(out.code).toContain("export const synth = defineProcessor(");
});

test("transform camel-cases a kebab-case filename into the export name", () => {
  expect(
    (callTransform(UWK_MINIMAL, "/abs/noise-drive.uwk.ts") as { code: string }).code,
  ).toContain("export const noiseDrive = defineProcessor(");
  expect((callTransform(UWK_MINIMAL, "/abs/tape-delay.uwk.ts") as { code: string }).code).toContain(
    "export const tapeDelay = defineProcessor(",
  );
});

test("transform falls back to `processor` when the filename has no identifier chars", () => {
  expect((callTransform(UWK_MINIMAL, "/abs/123.uwk.ts") as { code: string }).code).toContain(
    "export const processor = defineProcessor(",
  );
});

test("transform surfaces a lowering error via this.error", () => {
  // A .uwk.ts with no process() call is a LowerError, surfaced as a Vite error.
  expect(() =>
    callTransform(`const out = audioOutput({ channels: 1, name: "main" });`, "/abs/x.uwk.ts"),
  ).toThrow(/process/);
});

test("load lowers the .uwk.ts fixture, compiles it, and emits the WASM as a build asset", async () => {
  const { ctx } = await callLoadWithMockContext(`${VIRTUAL_ID_PREFIX}${FIXTURE_UWK_GAIN_PATH}`);

  const wasmCall = assetCalls(ctx).find((c) => c.name.endsWith(".wasm"));
  expect(wasmCall).toMatchObject({ type: "asset", name: "stereo-gain.wasm" });
  expect(wasmCall!.source).toBeInstanceOf(Uint8Array);
});

test("a .uwk.ts processor compiles to byte-identical WASM as its hand-written equivalent", async () => {
  // stereo-gain.uwk.ts is the sugar form of 01-stereo-gain.processor.ts; lowering
  // must be transparent, so both authoring forms emit the same WASM bytes.
  const { ctx: uwkCtx } = await callLoadWithMockContext(
    `${VIRTUAL_ID_PREFIX}${FIXTURE_UWK_GAIN_PATH}`,
  );
  const { ctx: tsCtx } = await callLoadWithMockContext(`${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`);
  const uwkWasm = assetCalls(uwkCtx).find((c) => c.name.endsWith(".wasm"))!.source as Uint8Array;
  const tsWasm = assetCalls(tsCtx).find((c) => c.name.endsWith(".wasm"))!.source as Uint8Array;
  expect(Buffer.from(uwkWasm).equals(Buffer.from(tsWasm))).toBe(true);
});

test("the .uwk.ts augmented module re-imports + registers under the filename-derived name", async () => {
  const { result } = await callLoadWithMockContext(`${VIRTUAL_ID_PREFIX}${FIXTURE_UWK_GAIN_PATH}`);

  const js = result as string;
  expect(js).toMatch(/processorName:\s*"stereoGain__[0-9a-f]{8}__[0-9a-f]{8}"/);
  expect(js).toContain("import { stereoGain as __unworkletRaw }");
  expect(js).toContain("export { __unworkletAugmented as stereoGain }");
});

test("load on the worklet-entry build branch lowers a .uwk.ts source", async () => {
  const result = await callLoadNoContext(`\0unworklet-worklet:${FIXTURE_UWK_GAIN_PATH}`);

  expect(typeof result).toBe("string");
  const js = result as string;
  expect(js).toContain("extends AudioWorkletProcessor");
  expect(js).toContain("stereoGain__");
});

test("load on a WORKLET_ENTRY_PREFIX id returns the worklet runtime template", async () => {
  const result = await callLoadNoContext(`\0unworklet-worklet:${FIXTURE_GAIN_PATH}`);

  expect(typeof result).toBe("string");
  const js = result as string;
  expect(js).toContain("extends AudioWorkletProcessor");
  expect(js).toContain("registerProcessor");
  expect(js).toContain("__unworkletNs.initialize");
  expect(js).toContain("__unworkletNs.process");
  expect(js).toContain("__unworkletNs.parameterDescriptors");
  // Critical contract: the worklet entry must not re-import the authoring
  // source — `makeWorkletNamespaceFromMeta` is the only bootstrap path。
  expect(js).toContain('from "@unworklet/core/worklet"');
  expect(js).not.toContain(FIXTURE_GAIN_PATH);
});

test("resolveId passes through WORKLET_ENTRY_PREFIX ids without modification", () => {
  const id = `\0unworklet-worklet:/abs/x.processor.ts`;
  expect(callResolveId(id, undefined)).toBe(id);
});

// ─────────────────────────────────────────────────────────────────────────
// Dev mode (= command === "serve") = middleware URL emission
// ─────────────────────────────────────────────────────────────────────────

test("dev mode: load returns JS that points moduleUrl through Vite's `/@id/` virtual + wasmUrl at the hash-pinned middleware URL", async () => {
  const result = await callLoadInServeMode(`${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`, {
    root: "/Users/yuichkun/workspace/unworklet/examples/01-stereo-gain",
  });
  const js = result as string;
  // Dev mode must NOT use the rollup placeholder (= it doesn't get rewritten
  // when rolldown isn't bundling)。
  expect(js).not.toContain("ROLLUP_FILE_URL_");
  // The worklet entry routes through Vite's `/@id/__x00__` virtual-module
  // URL so Vite's transform pipeline resolves the bare
  // `@unworklet/core/worklet` import inside the emitted template。
  expect(js).toMatch(/moduleUrl: "[^"]*\/@id\/__x00__unworklet-worklet:[^"]*\?v=[0-9a-f]{8}"/);
  // WASM URL keeps the dev middleware path, but with a revision hash so
  // a save between addModule + fetch cannot pair stale meta with new WASM。
  expect(js).toMatch(/wasmUrl: "[^"]*\/__unworklet\/[^"]*\/[0-9a-f]{8}\/wasm"/);
});

test("dev mode: relative `base: './'` falls back to absolute `/` for internal dev URLs", async () => {
  // Codex round-7 finding 3: Vite documents `base` may be `'./'` / `''`
  // for embedded deployment。 Plugin previously stored config.base verbatim
  // and the middleware's `startsWith('./__unworklet/')` could never match a
  // browser's resolved `/__unworklet/...` request。 Normalize to absolute
  // path for dev internal URLs。
  const result = await callLoadInServeMode(`${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`, {
    root: "/Users/yuichkun/workspace/unworklet/examples/01-stereo-gain",
    base: "./",
  });
  const js = result as string;
  expect(js).toMatch(/moduleUrl: "\/@id\/__x00__/);
  expect(js).toMatch(/wasmUrl: "\/__unworklet\//);
  // Critically the URLs must NOT start with `./` — that would never match
  // the middleware on a real browser request。
  expect(js).not.toMatch(/moduleUrl: "\.\/@id\//);
  expect(js).not.toMatch(/wasmUrl: "\.\/__unworklet\//);
});

test("dev mode: moduleUrl + wasmUrl carry the SAME revision hash inside a single load call", async () => {
  const result = await callLoadInServeMode(`${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`, {
    root: "/Users/yuichkun/workspace/unworklet/examples/01-stereo-gain",
  });
  const js = result as string;
  const moduleMatch = js.match(/moduleUrl: "[^"]*\?v=([0-9a-f]{8})"/);
  const wasmMatch = js.match(/wasmUrl: "[^"]*\/([0-9a-f]{8})\/wasm"/);
  expect(moduleMatch).not.toBeNull();
  expect(wasmMatch).not.toBeNull();
  expect(moduleMatch![1]).toBe(wasmMatch![1]);
});

test("dev mode: emits no rolldown chunk / asset (= no emitFile calls)", async () => {
  const plugin = unworklet();
  const configHook = plugin.configResolved as unknown as ConfigResolvedFn | undefined;
  if (!configHook) throw new Error("configResolved missing");
  configHook.call(null, { command: "serve", root: "/abs", base: "/" });
  const loadHook = plugin.load as unknown as LoadFn | undefined;
  if (!loadHook) throw new Error("load missing");
  const ctx = makeMockEmitContext();
  await loadHook.call(ctx, `${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`);
  expect(ctx.calls).toHaveLength(0);
});

test("dev mode: encoded source path round-trips through base64url", async () => {
  const result = await callLoadInServeMode(`${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`, {
    root: "/Users/yuichkun/workspace/unworklet/examples/01-stereo-gain",
  });
  const js = result as string;
  const match = js.match(/\/__unworklet\/([A-Za-z0-9_-]+)\/[0-9a-f]{8}\/wasm/);
  expect(match).not.toBeNull();
  const encoded = match![1]!;
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  expect(decoded).toBe(FIXTURE_GAIN_PATH);
});

test("load declares the source file as a watch dependency (= full-page reload picks up edits)", async () => {
  const { ctx } = await callLoadWithMockContext(`${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`);
  expect(ctx.watched).toContain(FIXTURE_GAIN_PATH);
});

test("emitted schema-hash JSON carries the same hash that compile() returned", async () => {
  const { ctx } = await callLoadWithMockContext(`${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`);
  const fixtureModule = (await import(FIXTURE_GAIN_PATH)) as Record<string, unknown>;
  const direct = await compile(fixtureModule["stereoGain"] as Parameters<typeof compile>[0]);

  const shCall = assetCalls(ctx).find((c) => c.name === "01-stereo-gain.schema-hash.json");
  expect(JSON.parse(shCall!.source as string)).toEqual({ schemaHash: direct.schemaHash });
});

test("`emitAnalysisArtifacts: false` suppresses the 4 metadata JSON emits (= wasm + worklet entry only)", async () => {
  const { ctx } = await callLoadWithMockContext(`${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`, {
    emitAnalysisArtifacts: false,
  });

  expect(ctx.calls).toHaveLength(2);
  const names = ctx.calls.map((c) => c.name).sort((a, b) => a.localeCompare(b));
  expect(names).toEqual(["01-stereo-gain.wasm", "01-stereo-gain.worklet"]);
});

// ─────────────────────────────────────────────────────────────────────────
// Dev mode middleware = allowlist + part validation
// ─────────────────────────────────────────────────────────────────────────
//
// The middleware decodes the source path out of the URL and `importFresh`-es
// it. Without an allowlist that path is attacker-controlled = a crafted
// request could evaluate any local TS file in the dev server's process。
// Gate = only paths the plugin has already accepted via `?worklet`
// `resolveId` are eligible。

type ConfigureServerFn = (this: unknown, server: ServerStub) => void;

type MiddlewareFn = (req: { url?: string }, res: ResponseStub, next: () => void) => void;

type ResponseStub = {
  statusCode?: number;
  setHeader: (k: string, v: string) => void;
  end: (body?: Buffer | string) => void;
  __endCalls: Array<Buffer | string | undefined>;
};

type ServerStub = {
  middlewares: { use: (fn: MiddlewareFn) => void };
  ssrLoadModule: (url: string) => Promise<Record<string, unknown>>;
  moduleGraph: {
    getModulesByFile: (file: string) => undefined;
  };
  __registered: MiddlewareFn[];
};

const makeServerStub = (): ServerStub => {
  const registered: MiddlewareFn[] = [];
  return {
    middlewares: {
      use: (fn) => {
        registered.push(fn);
      },
    },
    // Minimal ssrLoadModule stub — defer to Node's native ESM `import(...)`。
    // The real Vite implementation routes through the dev module graph so
    // transitive imports invalidate; for plugin-shape tests we only need a
    // path that returns the processor's exports。
    ssrLoadModule: async (url) => {
      const mod = (await import(url)) as Record<string, unknown>;
      return mod;
    },
    moduleGraph: {
      getModulesByFile: (_file: string) => undefined,
    },
    __registered: registered,
  };
};

const makeResponseStub = (): ResponseStub => {
  const endCalls: Array<Buffer | string | undefined> = [];
  return {
    setHeader: () => {},
    end: (body) => {
      endCalls.push(body);
    },
    __endCalls: endCalls,
  };
};

const setupServeMiddleware = (
  serveConfig: { root: string; base?: string } = { root: "/" },
): { plugin: ReturnType<typeof unworklet>; middleware: MiddlewareFn } => {
  const plugin = unworklet();
  const configHook = plugin.configResolved as unknown as ConfigResolvedFn | undefined;
  if (!configHook) throw new Error("configResolved missing");
  configHook.call(null, {
    command: "serve",
    root: serveConfig.root,
    base: serveConfig.base ?? "/",
  });
  const configureServerHook = plugin.configureServer as unknown as ConfigureServerFn | undefined;
  if (!configureServerHook) throw new Error("configureServer missing");
  const server = makeServerStub();
  configureServerHook.call(null, server);
  expect(server.__registered).toHaveLength(1);
  return { plugin, middleware: server.__registered[0]! };
};

const primeAllowlist = async (
  plugin: ReturnType<typeof unworklet>,
  sourcePath: string,
): Promise<void> => {
  const resolveHook = plugin.resolveId as unknown as ResolveIdFn | undefined;
  if (!resolveHook) throw new Error("resolveId missing");
  resolveHook.call(null, `${sourcePath}?worklet`, undefined, { isEntry: false });
};

test("dev middleware passes to next() for any path that did NOT come through resolveId", async () => {
  const { middleware } = setupServeMiddleware();
  // Encode an arbitrary local path the plugin has never seen via resolveId。
  const evilEncoded = Buffer.from("/etc/passwd", "utf8").toString("base64url");
  let nextCalled = 0;
  const res = makeResponseStub();
  middleware({ url: `/__unworklet/${evilEncoded}/wasm` }, res, () => {
    nextCalled++;
  });
  // The middleware must not have responded (= must yield to next())。
  await new Promise((r) => setTimeout(r, 0));
  expect(nextCalled).toBe(1);
  expect(res.__endCalls).toHaveLength(0);
});

test("dev middleware passes to next() when the URL part is neither 'wasm' nor 'worklet.js'", async () => {
  const { plugin, middleware } = setupServeMiddleware();
  // Even with an allowlisted path, a bogus part must not be served。
  await primeAllowlist(plugin, FIXTURE_GAIN_PATH);
  const encoded = Buffer.from(FIXTURE_GAIN_PATH, "utf8").toString("base64url");
  let nextCalled = 0;
  const res = makeResponseStub();
  middleware({ url: `/__unworklet/${encoded}/secret-config` }, res, () => {
    nextCalled++;
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(nextCalled).toBe(1);
  expect(res.__endCalls).toHaveLength(0);
});

test("dev middleware serves WASM bytes for an allowlisted source at the hash-pinned URL", async () => {
  const { plugin, middleware } = setupServeMiddleware({
    root: "/Users/yuichkun/workspace/unworklet/examples/01-stereo-gain",
  });
  await primeAllowlist(plugin, FIXTURE_GAIN_PATH);
  // Drive the load hook in dev mode so the plugin compiles + records a
  // snapshot for `FIXTURE_GAIN_PATH` and mints the matching revision hash。
  const loadHook = plugin.load as unknown as LoadFn | undefined;
  if (!loadHook) throw new Error("load missing");
  const loadCtx = makeMockEmitContext();
  const loadResult = (await loadHook.call(
    loadCtx,
    `${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`,
  )) as string;
  const wasmUrlMatch = loadResult.match(/wasmUrl: "([^"]+)"/);
  expect(wasmUrlMatch).not.toBeNull();
  const wasmUrlPath = wasmUrlMatch![1]!;
  // Strip the basePath leading slash for the middleware request shape。
  const res = makeResponseStub();
  let nextCalled = 0;
  middleware({ url: wasmUrlPath }, res, () => {
    nextCalled++;
  });
  // Wait for the async compile + send path inside the middleware to settle。
  await new Promise((r) => setTimeout(r, 200));
  expect(nextCalled).toBe(0);
  expect(res.__endCalls).toHaveLength(1);
  const body = res.__endCalls[0];
  expect(body).toBeInstanceOf(Buffer);
  // WASM binaries always start with the magic header `\0asm` (= 0x6d736100)。
  const buf = body as Buffer;
  expect(buf.subarray(0, 4).toString("hex")).toBe("0061736d");
});

// ─────────────────────────────────────────────────────────────────────────
// Dev/build symmetry = transitive imports get fanned out to addWatchFile
// ─────────────────────────────────────────────────────────────────────────
//
// Editing a helper file imported by a `?worklet` processor must invalidate
// the virtual module just like editing the processor itself does, otherwise
// dev serves stale DSP while build sees the new graph。 The plugin's dev path
// walks the dev server's module graph from the processor entry and adds each
// reachable file via `this.addWatchFile(...)`。

const callLoadInServeModeWithMockGraph = async (
  id: string,
  graph: { rootSourcePath: string; transitiveDeps: string[] },
): Promise<{ ctx: MockEmitContext }> => {
  const plugin = unworklet();
  const configHook = plugin.configResolved as unknown as ConfigResolvedFn | undefined;
  if (!configHook) throw new Error("configResolved missing");
  configHook.call(null, { command: "serve", root: "/", base: "/" });
  const configureServerHook = plugin.configureServer as unknown as ConfigureServerFn | undefined;
  if (!configureServerHook) throw new Error("configureServer missing");
  // Tiny module-graph stub: the root processor imports each transitive dep
  // directly. The real Vite module graph is recursive but a 1-deep fan-out
  // is enough to exercise `collectTransitiveDeps`'s BFS traversal。
  type Node = { file: string; importedModules: Set<Node> };
  const depNodes: Node[] = graph.transitiveDeps.map((file) => ({
    file,
    importedModules: new Set<Node>(),
  }));
  const rootNode: Node = {
    file: graph.rootSourcePath,
    importedModules: new Set<Node>(depNodes),
  };
  const server: ServerStub = {
    middlewares: { use: () => {} },
    ssrLoadModule: async (url) => (await import(url)) as Record<string, unknown>,
    moduleGraph: {
      // Real vite returns a Set (= same file can attach to multiple ids,
      // e.g. `foo.ts` vs `foo.ts?worklet`)。 Mock matches the contract。
      getModulesByFile: ((file: string) =>
        file === graph.rootSourcePath
          ? (new Set([rootNode]) as unknown)
          : undefined) as unknown as (file: string) => undefined,
    },
    __registered: [],
  };
  configureServerHook.call(null, server);
  const loadHook = plugin.load as unknown as LoadFn | undefined;
  if (!loadHook) throw new Error("load missing");
  const ctx = makeMockEmitContext();
  await loadHook.call(ctx, id);
  return { ctx };
};

test("dev mode load fans transitive helper imports out to addWatchFile", async () => {
  const helperA = "/abs/project/src/helpers/dsp-utils.ts";
  const helperB = "/abs/project/src/helpers/wavetable.ts";
  const { ctx } = await callLoadInServeModeWithMockGraph(
    `${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`,
    {
      rootSourcePath: FIXTURE_GAIN_PATH,
      transitiveDeps: [helperA, helperB],
    },
  );
  // Entry source itself is always watched (= the existing test already
  // covers this); the new contract is that helper files appear too。
  expect(ctx.watched).toContain(FIXTURE_GAIN_PATH);
  expect(ctx.watched).toContain(helperA);
  expect(ctx.watched).toContain(helperB);
});

test("dev mode WORKLET_ENTRY load rejects sourcePaths the plugin never accepted via `?worklet`", async () => {
  // Round-6 finding 1: Vite exposes virtual ids as `/@id/__x00__<rest>` in
  // dev, so a crafted request could otherwise force the worklet-entry load
  // hook to evaluate any local file。 Only sourcePaths the plugin itself
  // resolved via `?worklet` are eligible。
  const plugin = unworklet();
  const configHook = plugin.configResolved as unknown as ConfigResolvedFn | undefined;
  if (!configHook) throw new Error("configResolved missing");
  configHook.call(null, { command: "serve", root: "/abs", base: "/" });
  const loadHook = plugin.load as unknown as LoadFn | undefined;
  if (!loadHook) throw new Error("load missing");
  // Skip `?worklet` resolveId — the path is NOT allowlisted。
  const ctx = makeMockEmitContext();
  const result = await loadHook.call(ctx, `\0unworklet-worklet:/etc/passwd?v=deadbeef`);
  expect(result).toBeNull();
});

test("dev mode WORKLET_ENTRY load returns null for an allowlisted sourcePath with an unknown revision hash", async () => {
  // Round-6 finding 2: a stale `?v=<hash>` after the snapshot ring rolled
  // over must not silently emit a template against HEAD (= would pair stale
  // meta with new WASM)。 Plugin returns `null` so Vite responds 404 and
  // the consumer's `addModule()` rejects cleanly。
  const plugin = unworklet();
  const configHook = plugin.configResolved as unknown as ConfigResolvedFn | undefined;
  if (!configHook) throw new Error("configResolved missing");
  configHook.call(null, { command: "serve", root: "/", base: "/" });
  const resolveHook = plugin.resolveId as unknown as ResolveIdFn | undefined;
  if (!resolveHook) throw new Error("resolveId missing");
  // Allowlist the fixture path through resolveId。
  resolveHook.call(null, `${FIXTURE_GAIN_PATH}?worklet`, undefined, { isEntry: false });
  const loadHook = plugin.load as unknown as LoadFn | undefined;
  if (!loadHook) throw new Error("load missing");
  const ctx = makeMockEmitContext();
  // Request a hash the snapshot ring has never seen for this source。
  const result = await loadHook.call(ctx, `\0unworklet-worklet:${FIXTURE_GAIN_PATH}?v=deadbeef`);
  expect(result).toBeNull();
});

test("dev mode WORKLET_ENTRY load with a fresh snapshot emits the matching template (= same meta + processorName)", async () => {
  // Round-6 finding 2: the worklet-entry must look the template up out of
  // the per-revision snapshot ring filled by the main `?worklet` load。
  // Same hash twice → byte-identical template = no skew window。
  const plugin = unworklet();
  const configHook = plugin.configResolved as unknown as ConfigResolvedFn | undefined;
  if (!configHook) throw new Error("configResolved missing");
  configHook.call(null, { command: "serve", root: "/", base: "/" });
  const resolveHook = plugin.resolveId as unknown as ResolveIdFn | undefined;
  if (!resolveHook) throw new Error("resolveId missing");
  resolveHook.call(null, `${FIXTURE_GAIN_PATH}?worklet`, undefined, { isEntry: false });
  const loadHook = plugin.load as unknown as LoadFn | undefined;
  if (!loadHook) throw new Error("load missing");
  // Trigger the primary load = fills the snapshot ring + bakes the hash
  // into both URLs。 Extract the hash from the emitted JS。
  const augmentedJs = (await loadHook.call(
    makeMockEmitContext(),
    `${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`,
  )) as string;
  const hashMatch = augmentedJs.match(/\?v=([0-9a-f]{8})/);
  expect(hashMatch).not.toBeNull();
  const hash = hashMatch![1]!;
  const templateA = (await loadHook.call(
    makeMockEmitContext(),
    `\0unworklet-worklet:${FIXTURE_GAIN_PATH}?v=${hash}`,
  )) as string;
  expect(typeof templateA).toBe("string");
  expect(templateA).toContain("registerProcessor");
  expect(templateA).toContain('from "@unworklet/core/worklet"');
  // Idempotency: second request with the same hash yields the same bytes
  // (= no recompile, no skew window even if disk content drifted)。
  const templateB = (await loadHook.call(
    makeMockEmitContext(),
    `\0unworklet-worklet:${FIXTURE_GAIN_PATH}?v=${hash}`,
  )) as string;
  expect(templateB).toBe(templateA);
});

test("dev mode transitive watch keys off `getModulesByFile`, not `getModuleById`", async () => {
  // Regression for codex round-3 finding (high)。 Vite stores modules under
  // possibly multiple resolved ids per file (= query suffixes, plugin-
  // resolved virtuals)、 so id-based lookup misses dependency fanout when
  // the resolved id differs from the source file path。 The plugin's
  // collectTransitiveDeps must root from `getModulesByFile`。
  const helperA = "/abs/project/src/helpers/dsp-utils.ts";
  type GraphNode = { file: string; importedModules: Set<GraphNode> };
  const helperNode: GraphNode = { file: helperA, importedModules: new Set() };
  const rootNode: GraphNode = {
    file: FIXTURE_GAIN_PATH,
    importedModules: new Set([helperNode]),
  };
  let getModuleByIdCallCount = 0;
  let getModulesByFileCallCount = 0;

  const plugin = unworklet();
  const configHook = plugin.configResolved as unknown as ConfigResolvedFn | undefined;
  if (!configHook) throw new Error("configResolved missing");
  configHook.call(null, { command: "serve", root: "/", base: "/" });
  const configureServerHook = plugin.configureServer as unknown as ConfigureServerFn | undefined;
  if (!configureServerHook) throw new Error("configureServer missing");
  const server = {
    middlewares: { use: () => {} },
    ssrLoadModule: async (url: string) => (await import(url)) as Record<string, unknown>,
    moduleGraph: {
      // Intentionally null so a regression on id-based lookup would lose
      // the helper fanout entirely。
      getModuleById: ((_id: string) => {
        getModuleByIdCallCount++;
        return undefined;
      }) as unknown,
      getModulesByFile: ((file: string) => {
        getModulesByFileCallCount++;
        return file === FIXTURE_GAIN_PATH ? new Set([rootNode]) : undefined;
      }) as unknown,
    },
    __registered: [] as MiddlewareFn[],
  } as unknown as ServerStub;
  configureServerHook.call(null, server);
  const loadHook = plugin.load as unknown as LoadFn | undefined;
  if (!loadHook) throw new Error("load missing");
  const ctx = makeMockEmitContext();
  await loadHook.call(ctx, `${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`);

  expect(ctx.watched).toContain(helperA);
  expect(getModulesByFileCallCount).toBeGreaterThan(0);
  expect(getModuleByIdCallCount).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────
// collectTransitiveDeps = BFS continue paths
// ─────────────────────────────────────────────────────────────────────────
//
// `collectTransitiveDeps` walks the module graph BFS from `sourcePath`. The
// three continue branches inside the loop guard against (a) virtual nodes
// without a backing file, (b) the entry itself reached transitively, and
// (c) revisiting an already-seen file — each must skip without losing the
// rest of the fan-out。 The recursion-depth branch (L161) requires a
// dependency that itself has children, exercising the BFS queue beyond a
// single hop。

const callLoadInServeModeWithCustomGraph = async (
  id: string,
  build: (rootSourcePath: string) => {
    rootNode: { file: string; importedModules: Set<unknown> };
  },
): Promise<{ ctx: MockEmitContext }> => {
  const plugin = unworklet();
  const configHook = plugin.configResolved as unknown as ConfigResolvedFn | undefined;
  if (!configHook) throw new Error("configResolved missing");
  configHook.call(null, { command: "serve", root: "/", base: "/" });
  const configureServerHook = plugin.configureServer as unknown as ConfigureServerFn | undefined;
  if (!configureServerHook) throw new Error("configureServer missing");
  const { rootNode } = build(FIXTURE_GAIN_PATH);
  const server: ServerStub = {
    middlewares: { use: () => {} },
    ssrLoadModule: async (url) => (await import(url)) as Record<string, unknown>,
    moduleGraph: {
      getModulesByFile: ((file: string) =>
        file === FIXTURE_GAIN_PATH ? (new Set([rootNode]) as unknown) : undefined) as unknown as (
        file: string,
      ) => undefined,
    },
    __registered: [],
  };
  configureServerHook.call(null, server);
  const loadHook = plugin.load as unknown as LoadFn | undefined;
  if (!loadHook) throw new Error("load missing");
  const ctx = makeMockEmitContext();
  await loadHook.call(ctx, id);
  return { ctx };
};

test("collectTransitiveDeps skips a dependency without a `file` (virtual node)", async () => {
  // L157: virtual modules (= `\0...`) appear in the graph as nodes with
  // `file: null` since they have no backing file。 Must continue past them
  // without throwing on the missing path。
  const virtualNoFileDep = {
    file: null,
    importedModules: new Set<unknown>(),
  };
  const realDep = {
    file: "/abs/project/src/real-helper.ts",
    importedModules: new Set<unknown>(),
  };
  const { ctx } = await callLoadInServeModeWithCustomGraph(
    `${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`,
    () => ({
      rootNode: {
        file: FIXTURE_GAIN_PATH,
        importedModules: new Set<unknown>([virtualNoFileDep, realDep]),
      },
    }),
  );
  // The real helper still gets watched even though the virtual node is in
  // the same dependency set。
  expect(ctx.watched).toContain("/abs/project/src/real-helper.ts");
  expect(ctx.watched).not.toContain(null as unknown as string);
});

test("collectTransitiveDeps skips a dependency whose file === sourcePath (self-reference)", async () => {
  // L158: a transitive import that points back at the entry must NOT
  // appear as a watch dep — the entry is the plugin's own canonical
  // watcher target via the load hook, double-watching would be a bug。
  const selfRef = {
    file: FIXTURE_GAIN_PATH,
    importedModules: new Set<unknown>(),
  };
  const otherDep = {
    file: "/abs/project/src/other.ts",
    importedModules: new Set<unknown>(),
  };
  const { ctx } = await callLoadInServeModeWithCustomGraph(
    `${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`,
    () => ({
      rootNode: {
        file: FIXTURE_GAIN_PATH,
        importedModules: new Set<unknown>([selfRef, otherDep]),
      },
    }),
  );
  // Entry comes through addWatchFile(sourcePath) in load itself = 1 occurrence。
  const entryCount = ctx.watched.filter((p) => p === FIXTURE_GAIN_PATH).length;
  expect(entryCount).toBe(1);
  expect(ctx.watched).toContain("/abs/project/src/other.ts");
});

test("collectTransitiveDeps skips an already-seen file (diamond dependency)", async () => {
  // L159: same helper reached via two paths in the graph must only get
  // watched once — duplicate addWatchFile() calls are harmless but the
  // BFS seen-set is what guards against an exponential walk on diamond
  // graphs。
  const sharedHelper = {
    file: "/abs/project/src/shared.ts",
    importedModules: new Set<unknown>(),
  };
  const branchA = {
    file: "/abs/project/src/branch-a.ts",
    importedModules: new Set<unknown>([sharedHelper]),
  };
  const branchB = {
    file: "/abs/project/src/branch-b.ts",
    importedModules: new Set<unknown>([sharedHelper]),
  };
  const { ctx } = await callLoadInServeModeWithCustomGraph(
    `${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`,
    () => ({
      rootNode: {
        file: FIXTURE_GAIN_PATH,
        importedModules: new Set<unknown>([branchA, branchB]),
      },
    }),
  );
  expect(ctx.watched).toContain("/abs/project/src/branch-a.ts");
  expect(ctx.watched).toContain("/abs/project/src/branch-b.ts");
  // The shared helper is watched exactly once even though two parents
  // import it。
  const sharedCount = ctx.watched.filter((p) => p === "/abs/project/src/shared.ts").length;
  expect(sharedCount).toBe(1);
});

test("collectTransitiveDeps recurses through nested helper imports (BFS depth >= 2)", async () => {
  // L161: the BFS queue must continue past depth 1 so a helper imported
  // by another helper still triggers invalidation. Without the inner
  // `for (const child of node.importedModules)` queue push, only the
  // root's direct imports would get watched。
  const deepHelper = {
    file: "/abs/project/src/deep.ts",
    importedModules: new Set<unknown>(),
  };
  const midHelper = {
    file: "/abs/project/src/mid.ts",
    importedModules: new Set<unknown>([deepHelper]),
  };
  const { ctx } = await callLoadInServeModeWithCustomGraph(
    `${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`,
    () => ({
      rootNode: {
        file: FIXTURE_GAIN_PATH,
        importedModules: new Set<unknown>([midHelper]),
      },
    }),
  );
  expect(ctx.watched).toContain("/abs/project/src/mid.ts");
  expect(ctx.watched).toContain("/abs/project/src/deep.ts");
});

// ─────────────────────────────────────────────────────────────────────────
// configResolved = base path normalization
// ─────────────────────────────────────────────────────────────────────────

test("configResolved appends `/` when `base` is an absolute path without trailing slash", async () => {
  // L505 cond-expr false branch: `config.base = "/sub"` (= absolute,
  // no trailing slash) must be normalized so the dev URL prefix becomes
  // `/sub/__unworklet/...` rather than `/sub__unworklet/...`。
  const plugin = unworklet();
  const configHook = plugin.configResolved as unknown as ConfigResolvedFn | undefined;
  if (!configHook) throw new Error("configResolved missing");
  configHook.call(null, { command: "serve", root: "/", base: "/sub" });
  const resolveHook = plugin.resolveId as unknown as ResolveIdFn | undefined;
  if (!resolveHook) throw new Error("resolveId missing");
  resolveHook.call(null, `${FIXTURE_GAIN_PATH}?worklet`, undefined, { isEntry: false });
  const loadHook = plugin.load as unknown as LoadFn | undefined;
  if (!loadHook) throw new Error("load missing");
  const ctx = makeMockEmitContext();
  const result = (await loadHook.call(ctx, `${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`)) as string;
  // The trailing slash is appended so URLs land under `/sub/...`。
  expect(result).toMatch(/moduleUrl: "\/sub\/@id\/__x00__/);
  expect(result).toMatch(/wasmUrl: "\/sub\/__unworklet\//);
});

// ─────────────────────────────────────────────────────────────────────────
// Middleware = early-return paths
// ─────────────────────────────────────────────────────────────────────────

test("dev middleware passes to next() when `req.url` is undefined", async () => {
  // L526: an upstream connect handler can leave req.url unset (= raw
  // socket handshake) — the middleware must defer rather than crash。
  const { middleware } = setupServeMiddleware();
  let nextCalled = 0;
  const res = makeResponseStub();
  middleware({ url: undefined }, res, () => {
    nextCalled++;
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(nextCalled).toBe(1);
  expect(res.__endCalls).toHaveLength(0);
});

test("dev middleware ignores the query string when matching against the dev URL prefix", async () => {
  // L528 cond-expr false branch: a real browser request commonly carries
  // a `?import` / `?t=<ts>` query suffix。 The middleware must strip the
  // query before the `startsWith(devUrlBase)` check so a query-suffixed
  // path under a non-`__unworklet` route correctly falls through to
  // next() rather than spuriously matching。
  const { middleware } = setupServeMiddleware();
  let nextCalled = 0;
  const res = makeResponseStub();
  middleware({ url: "/some-other-route?t=123" }, res, () => {
    nextCalled++;
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(nextCalled).toBe(1);
  expect(res.__endCalls).toHaveLength(0);
});

test("dev middleware passes to next() for a URL that does not start with the dev prefix", async () => {
  // L529: any request outside the `/__unworklet/` namespace must be left
  // alone (= other vite plugins / app routes handle it)。
  const { middleware } = setupServeMiddleware();
  let nextCalled = 0;
  const res = makeResponseStub();
  middleware({ url: "/totally/unrelated.js" }, res, () => {
    nextCalled++;
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(nextCalled).toBe(1);
  expect(res.__endCalls).toHaveLength(0);
});

test("dev middleware passes to next() when the URL has the wrong number of segments", async () => {
  // L533 (segments.length !== 3): existing test exercises the
  // `<encoded>/<part>` two-segment form via `secret-config`。 Add a
  // single-segment form to cover the lower bound just as defensively。
  const { middleware } = setupServeMiddleware();
  let nextCalled = 0;
  const res = makeResponseStub();
  middleware({ url: "/__unworklet/onlyonesegment" }, res, () => {
    nextCalled++;
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(nextCalled).toBe(1);
  expect(res.__endCalls).toHaveLength(0);
});

test("dev middleware passes to next() when the final segment is not `wasm`", async () => {
  // L535: `<encoded>/<hash>/<not-wasm>` shape — even with a valid hash
  // and an allowlisted source, anything but `wasm` is not this
  // middleware's concern (= future asset kinds may share the prefix)。
  const { plugin, middleware } = setupServeMiddleware();
  await primeAllowlist(plugin, FIXTURE_GAIN_PATH);
  const encoded = Buffer.from(FIXTURE_GAIN_PATH, "utf8").toString("base64url");
  let nextCalled = 0;
  const res = makeResponseStub();
  middleware({ url: `/__unworklet/${encoded}/deadbeef/not-wasm` }, res, () => {
    nextCalled++;
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(nextCalled).toBe(1);
  expect(res.__endCalls).toHaveLength(0);
});

test("dev middleware passes to next() when the hash segment is not 8 hex chars", async () => {
  // L536: a stale URL pointing at a non-hex hash (= e.g. truncated
  // copy-paste) must defer rather than serve `404`-equivalent middleware
  // body, so other middlewares get a chance。
  const { plugin, middleware } = setupServeMiddleware();
  await primeAllowlist(plugin, FIXTURE_GAIN_PATH);
  const encoded = Buffer.from(FIXTURE_GAIN_PATH, "utf8").toString("base64url");
  let nextCalled = 0;
  const res = makeResponseStub();
  middleware({ url: `/__unworklet/${encoded}/NOTHEX!/wasm` }, res, () => {
    nextCalled++;
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(nextCalled).toBe(1);
  expect(res.__endCalls).toHaveLength(0);
});

test("dev middleware passes to next() when the encoded sourcePath decodes to an empty string", async () => {
  // L544: `decodeSourceFromDevUrl` returns "" for an empty encoded
  // segment (= `Buffer.from("", "base64url").toString("utf8") === ""`)
  // and `!""` is truthy, so the middleware must defer rather than
  // accidentally evaluate the empty string as a source path。
  const { middleware } = setupServeMiddleware();
  let nextCalled = 0;
  const res = makeResponseStub();
  // Empty encoded segment + valid 8-hex hash + `wasm` part = 3 segments
  // that pass the structural checks but yield an empty sourcePath。
  middleware({ url: `/__unworklet//deadbeef/wasm` }, res, () => {
    nextCalled++;
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(nextCalled).toBe(1);
  expect(res.__endCalls).toHaveLength(0);
});

test("dev middleware passes to next() when the URL shape is valid but the sourcePath is not allowlisted", async () => {
  // L547: a crafted request with a syntactically valid shape but a
  // sourcePath the plugin never accepted via `?worklet` must fall
  // through (= the security gate)。 Unlike the existing `evilEncoded`
  // case (which exits earlier on segment count), this URL passes every
  // shape check up to the allowlist test。
  const { middleware } = setupServeMiddleware();
  // `/etc/passwd` base64url-encoded — the plugin has not seen it via
  // resolveId, so `allowedSources.has(...)` returns false。
  const evilEncoded = Buffer.from("/etc/passwd", "utf8").toString("base64url");
  let nextCalled = 0;
  const res = makeResponseStub();
  middleware({ url: `/__unworklet/${evilEncoded}/deadbeef/wasm` }, res, () => {
    nextCalled++;
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(nextCalled).toBe(1);
  expect(res.__endCalls).toHaveLength(0);
});

test("dev middleware fresh-compiles on snapshot miss and replies 410 when the requested hash no longer matches HEAD", async () => {
  // L556 + L572: client holds an outdated `?v=<old-hash>` URL minted
  // from an earlier compile that has since rolled out of the ring。 The
  // middleware recompiles from current disk content, but rather than
  // silently serving the new bytes (= would skew with the still-stale
  // moduleUrl meta on the client), it emits a 410 Gone。
  const { plugin, middleware } = setupServeMiddleware({
    root: "/Users/yuichkun/workspace/unworklet/examples/01-stereo-gain",
  });
  await primeAllowlist(plugin, FIXTURE_GAIN_PATH);
  // Request a hash the snapshot ring has never seen — the middleware
  // falls through to a fresh compile and finds a different hash。
  const encoded = Buffer.from(FIXTURE_GAIN_PATH, "utf8").toString("base64url");
  const res = makeResponseStub();
  let nextCalled = 0;
  middleware({ url: `/__unworklet/${encoded}/deadbeef/wasm` }, res, () => {
    nextCalled++;
  });
  // Wait for the async compile path to settle。
  await new Promise((r) => setTimeout(r, 300));
  expect(nextCalled).toBe(0);
  expect(res.statusCode).toBe(410);
  expect(res.__endCalls).toHaveLength(1);
  expect(String(res.__endCalls[0])).toMatch(/no longer available/);
});

test("dev middleware fresh-compiles on snapshot miss and serves the bytes when the hash happens to match", async () => {
  // L556 (snapshot miss → fresh compile) without the L572 mismatch
  // branch: a client requests the current revision but the snapshot
  // ring was cleared (= reproduced here by skipping the `?worklet`
  // load path so no snapshot is recorded up front)。 The middleware
  // must recompile, record the fresh snapshot, and serve the bytes。
  const { plugin, middleware } = setupServeMiddleware({
    root: "/Users/yuichkun/workspace/unworklet/examples/01-stereo-gain",
  });
  await primeAllowlist(plugin, FIXTURE_GAIN_PATH);
  // Compute the current revision hash by invoking compile() directly so
  // we know which URL the middleware should accept。
  const fixtureModule = (await import(FIXTURE_GAIN_PATH)) as Record<string, unknown>;
  const direct = await compile(fixtureModule["stereoGain"] as Parameters<typeof compile>[0]);
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(direct.wasm).digest("hex").slice(0, 8);
  const encoded = Buffer.from(FIXTURE_GAIN_PATH, "utf8").toString("base64url");
  const res = makeResponseStub();
  let nextCalled = 0;
  middleware({ url: `/__unworklet/${encoded}/${hash}/wasm` }, res, () => {
    nextCalled++;
  });
  await new Promise((r) => setTimeout(r, 300));
  expect(nextCalled).toBe(0);
  expect(res.__endCalls).toHaveLength(1);
  const body = res.__endCalls[0] as Buffer;
  expect(body).toBeInstanceOf(Buffer);
  // WASM magic header guarantees we served real bytes, not an error blob。
  expect(body.subarray(0, 4).toString("hex")).toBe("0061736d");
});

test("dev middleware responds 500 when the source module fails to evaluate", async () => {
  // L584 async catch: the middleware's compile path can throw at any
  // step (ssrLoadModule / pickCompiledProcessor / compile)。 On error
  // it must surface a 500 instead of silently leaking the rejection。
  // Trigger via a fixture that has no defineProcessor exports —
  // pickCompiledProcessor throws synchronously inside the async IIFE。
  const { plugin, middleware } = setupServeMiddleware({
    root: "/Users/yuichkun/workspace/unworklet/examples/01-stereo-gain",
  });
  await primeAllowlist(plugin, FIXTURE_NO_PROCESSOR_PATH);
  const encoded = Buffer.from(FIXTURE_NO_PROCESSOR_PATH, "utf8").toString("base64url");
  const res = makeResponseStub();
  let nextCalled = 0;
  // Silence the console.error inside the catch so test output stays
  // readable — the contract is still that the response is 500 + body。
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  middleware({ url: `/__unworklet/${encoded}/deadbeef/wasm` }, res, () => {
    nextCalled++;
  });
  await new Promise((r) => setTimeout(r, 300));
  errSpy.mockRestore();
  expect(nextCalled).toBe(0);
  expect(res.statusCode).toBe(500);
  expect(res.__endCalls).toHaveLength(1);
  expect(String(res.__endCalls[0])).toMatch(/no defineProcessor exports/);
});

// ─────────────────────────────────────────────────────────────────────────
// WORKLET_ENTRY load = hash-format rejection
// ─────────────────────────────────────────────────────────────────────────

test("dev mode WORKLET_ENTRY load returns null when the `?v=` query is missing entirely", async () => {
  // L622 binary-expr fallback (`params.get("v") ?? ""`) + L623 8-hex
  // mismatch: a request without `?v=` falls through to the empty string
  // sentinel, which then fails the hex regex test = null。 Prevents the
  // middleware from being tricked into serving a template against an
  // unknown revision when the client forgot to round-trip the hash。
  const plugin = unworklet();
  const configHook = plugin.configResolved as unknown as ConfigResolvedFn | undefined;
  if (!configHook) throw new Error("configResolved missing");
  configHook.call(null, { command: "serve", root: "/", base: "/" });
  const resolveHook = plugin.resolveId as unknown as ResolveIdFn | undefined;
  if (!resolveHook) throw new Error("resolveId missing");
  // Allowlist the fixture so the security gate does NOT short-circuit。
  resolveHook.call(null, `${FIXTURE_GAIN_PATH}?worklet`, undefined, { isEntry: false });
  const loadHook = plugin.load as unknown as LoadFn | undefined;
  if (!loadHook) throw new Error("load missing");
  const ctx = makeMockEmitContext();
  // No `?v=` on the entry id — the only path that drives L622's
  // fallback branch + L623's regex rejection。
  const result = await loadHook.call(ctx, `\0unworklet-worklet:${FIXTURE_GAIN_PATH}`);
  expect(result).toBeNull();
});

test("dev mode WORKLET_ENTRY load returns null when the `?v=` value is malformed", async () => {
  // L623 regex rejection on a non-8-hex value (= e.g. a truncated copy
  // or a wrong-shape token someone hard-coded)。
  const plugin = unworklet();
  const configHook = plugin.configResolved as unknown as ConfigResolvedFn | undefined;
  if (!configHook) throw new Error("configResolved missing");
  configHook.call(null, { command: "serve", root: "/", base: "/" });
  const resolveHook = plugin.resolveId as unknown as ResolveIdFn | undefined;
  if (!resolveHook) throw new Error("resolveId missing");
  resolveHook.call(null, `${FIXTURE_GAIN_PATH}?worklet`, undefined, { isEntry: false });
  const loadHook = plugin.load as unknown as LoadFn | undefined;
  if (!loadHook) throw new Error("load missing");
  const ctx = makeMockEmitContext();
  const result = await loadHook.call(ctx, `\0unworklet-worklet:${FIXTURE_GAIN_PATH}?v=NOTHEX!!`);
  expect(result).toBeNull();
});

// ─────────────────────────────────────────────────────────────────────────
// recordSnapshot = ring re-use + dedupe
// ─────────────────────────────────────────────────────────────────────────

test("dev mode reuses the same snapshot ring across two loads of the same source (dedupe + ring re-use)", async () => {
  // L479 (ring already exists) + L485 (existing >= 0 = de-dupe by hash):
  // two consecutive dev-mode loads of the same fixture compute the
  // same revision hash, so the second `recordSnapshot` must find the
  // existing entry, splice it out, and re-push — preserving ring
  // semantics without growing past SNAPSHOT_RING_SIZE。 Asserted
  // indirectly by checking that both loads yield byte-identical JS
  // (= same hash baked in)。
  const plugin = unworklet();
  const configHook = plugin.configResolved as unknown as ConfigResolvedFn | undefined;
  if (!configHook) throw new Error("configResolved missing");
  configHook.call(null, { command: "serve", root: "/", base: "/" });
  const resolveHook = plugin.resolveId as unknown as ResolveIdFn | undefined;
  if (!resolveHook) throw new Error("resolveId missing");
  resolveHook.call(null, `${FIXTURE_GAIN_PATH}?worklet`, undefined, { isEntry: false });
  const configureServerHook = plugin.configureServer as unknown as ConfigureServerFn | undefined;
  if (!configureServerHook) throw new Error("configureServer missing");
  const server = makeServerStub();
  configureServerHook.call(null, server);
  const loadHook = plugin.load as unknown as LoadFn | undefined;
  if (!loadHook) throw new Error("load missing");
  const firstCtx = makeMockEmitContext();
  const first = (await loadHook.call(
    firstCtx,
    `${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`,
  )) as string;
  const secondCtx = makeMockEmitContext();
  const second = (await loadHook.call(
    secondCtx,
    `${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`,
  )) as string;
  // Same source + same compile result → same hash → byte-identical JS。
  expect(second).toBe(first);
});

// ─────────────────────────────────────────────────────────────────────────
// devtools setup = full UI panel registration
// ─────────────────────────────────────────────────────────────────────────
//
// `setupDevtools` is the plugin's `devtools.setup` callback。 It registers
// 5 diagnostic codes, logs one of each, posts a top-level message, and
// installs a single dock entry routed at a static SPA root。 We mock the
// devtools-kit context surface with a minimum-shape stub and assert the
// observable side effects。

type DiagnosticsLoggerStub = {
  UWK0001: (params: { src: string; sym: string }) => void;
  UWK0002: (params: Record<string, never>) => void;
  UWK0004: (params: Record<string, never>) => void;
  UWK0011: (params: { src: string }) => void;
  UWK0015: (params: { src: string; slot: string }) => void;
};

type DevToolsCtxStub = {
  diagnostics: {
    defineDiagnostics: (def: unknown) => unknown;
    register: (d: unknown) => void;
    logger: DiagnosticsLoggerStub;
    __defineCalls: unknown[];
    __registerCalls: unknown[];
    __loggerCalls: Array<{ code: string; params: unknown }>;
  };
  messages: {
    add: (m: unknown) => Promise<void>;
    __addCalls: unknown[];
  };
  docks: {
    register: (entry: unknown) => void;
    __registerCalls: unknown[];
  };
  views: {
    hostStatic: (urlBase: string, root: string) => void;
    __hostStaticCalls: Array<{ urlBase: string; root: string }>;
  };
  rpc: {
    sharedState: {
      get: (
        key: string,
        opts?: unknown,
      ) => Promise<{
        value: () => unknown;
        on: (ev: string, cb: (v: unknown) => void) => void;
        mutate: (fn: (draft: { nodes: unknown[]; edges: unknown[] }) => void) => void;
      }>;
    };
    register: (fn: unknown) => void;
    __registerCalls: unknown[];
    __sharedStateGets: string[];
  };
};

const makeDevToolsCtxStub = (): DevToolsCtxStub => {
  const loggerCalls: Array<{ code: string; params: unknown }> = [];
  const defineCalls: unknown[] = [];
  const registerCalls: unknown[] = [];
  const messageAddCalls: unknown[] = [];
  const dockRegisterCalls: unknown[] = [];
  const hostStaticCalls: Array<{ urlBase: string; root: string }> = [];
  const rpcRegisterCalls: unknown[] = [];
  const sharedStateGets: string[] = [];
  const logger: DiagnosticsLoggerStub = {
    UWK0001: (params) => loggerCalls.push({ code: "UWK0001", params }),
    UWK0002: (params) => loggerCalls.push({ code: "UWK0002", params }),
    UWK0004: (params) => loggerCalls.push({ code: "UWK0004", params }),
    UWK0011: (params) => loggerCalls.push({ code: "UWK0011", params }),
    UWK0015: (params) => loggerCalls.push({ code: "UWK0015", params }),
  };
  return {
    diagnostics: {
      defineDiagnostics: (def) => {
        defineCalls.push(def);
        return def;
      },
      register: (d) => {
        registerCalls.push(d);
      },
      logger,
      __defineCalls: defineCalls,
      __registerCalls: registerCalls,
      __loggerCalls: loggerCalls,
    },
    messages: {
      add: async (m) => {
        messageAddCalls.push(m);
      },
      __addCalls: messageAddCalls,
    },
    docks: {
      register: (entry) => {
        dockRegisterCalls.push(entry);
      },
      __registerCalls: dockRegisterCalls,
    },
    views: {
      hostStatic: (urlBase, root) => {
        hostStaticCalls.push({ urlBase, root });
      },
      __hostStaticCalls: hostStaticCalls,
    },
    rpc: {
      sharedState: {
        get: async (key) => {
          sharedStateGets.push(key);
          const current = { nodes: [] as unknown[], edges: [] as unknown[] };
          return {
            value: () => current,
            on: () => {},
            mutate: (fn) => {
              fn(current);
            },
          };
        },
      },
      register: (fn) => {
        rpcRegisterCalls.push(fn);
      },
      __registerCalls: rpcRegisterCalls,
      __sharedStateGets: sharedStateGets,
    },
  };
};

test("devtools.setup defines the 5 diagnostic codes (UWK0001/UWK0002/UWK0004/UWK0011/UWK0015)", () => {
  const plugin = unworklet();
  // PluginWithDevTools augments Plugin with an optional `devtools` slot
  // that the kit reads。 We dig through that union since `Plugin` from
  // vite-plus does not surface it natively in test types。
  const setup = (plugin as unknown as { devtools?: { setup: (ctx: unknown) => void } }).devtools
    ?.setup;
  expect(typeof setup).toBe("function");
  const ctx = makeDevToolsCtxStub();
  setup!(ctx);
  expect(ctx.diagnostics.__defineCalls).toHaveLength(1);
  const def = ctx.diagnostics.__defineCalls[0] as { codes: Record<string, unknown> };
  expect(Object.keys(def.codes).sort()).toEqual([
    "UWK0001",
    "UWK0002",
    "UWK0004",
    "UWK0011",
    "UWK0015",
  ]);
});

test("devtools.setup registers the diagnostics definition with the kit", () => {
  const plugin = unworklet();
  const setup = (plugin as unknown as { devtools?: { setup: (ctx: unknown) => void } }).devtools
    ?.setup;
  const ctx = makeDevToolsCtxStub();
  setup!(ctx);
  expect(ctx.diagnostics.__registerCalls).toHaveLength(1);
});

test("devtools.setup emits one log entry per diagnostic code (=  5 entries, code coverage)", () => {
  const plugin = unworklet();
  const setup = (plugin as unknown as { devtools?: { setup: (ctx: unknown) => void } }).devtools
    ?.setup;
  const ctx = makeDevToolsCtxStub();
  setup!(ctx);
  const codes = ctx.diagnostics.__loggerCalls.map((c) => c.code).sort();
  expect(codes).toEqual(["UWK0001", "UWK0002", "UWK0004", "UWK0011", "UWK0015"]);
});

test("devtools.setup exercises each diagnostic message's `why` function with concrete params", () => {
  // The `why` slots are functions or literals; invoking them at setup
  // time also covers the lambda bodies (= L364-385 of index.ts)。
  const plugin = unworklet();
  const setup = (plugin as unknown as { devtools?: { setup: (ctx: unknown) => void } }).devtools
    ?.setup;
  const ctx = makeDevToolsCtxStub();
  setup!(ctx);
  const def = ctx.diagnostics.__defineCalls[0] as {
    codes: Record<
      string,
      { why: string | ((params: Record<string, unknown>) => string); fix: string }
    >;
  };
  // Exercise each `why` (= lambda or string) so the body is actually
  // executed under coverage。
  const uwk1 = def.codes["UWK0001"]!.why;
  const w1 = typeof uwk1 === "function" ? uwk1({ src: "X", sym: "Y" }) : uwk1;
  expect(w1).toMatch(/scope-violation/);
  const uwk2 = def.codes["UWK0002"]!.why;
  const w2 = typeof uwk2 === "function" ? uwk2({}) : uwk2;
  expect(w2).toMatch(/illegal-stride/);
  const uwk4 = def.codes["UWK0004"]!.why;
  const w4 = typeof uwk4 === "function" ? uwk4({}) : uwk4;
  expect(w4).toMatch(/memory-budget/);
  const uwk11 = def.codes["UWK0011"]!.why;
  const w11 = typeof uwk11 === "function" ? uwk11({ src: "Z" }) : uwk11;
  expect(w11).toMatch(/constant-truthy-emitif/);
  const uwk15 = def.codes["UWK0015"]!.why;
  const w15 = typeof uwk15 === "function" ? uwk15({ src: "P", slot: "Q" }) : uwk15;
  expect(w15).toMatch(/unused-named-slot/);
});

test("devtools.setup posts the build-issues summary message", () => {
  const plugin = unworklet();
  const setup = (plugin as unknown as { devtools?: { setup: (ctx: unknown) => void } }).devtools
    ?.setup;
  const ctx = makeDevToolsCtxStub();
  setup!(ctx);
  expect(ctx.messages.__addCalls).toHaveLength(1);
  const msg = ctx.messages.__addCalls[0] as {
    level: string;
    message: string;
    notify?: boolean;
  };
  expect(msg.level).toBe("error");
  expect(msg.message).toMatch(/unworklet/);
  expect(msg.notify).toBe(true);
});

test("resolveDevtoolsUiRoot falls back to the first candidate path when nothing exists on disk", async () => {
  // L179: `candidates.find(existsSync) ?? candidates[0]` — when neither
  // the packed `dist/ui` nor the source `devtools-ui/dist` exists (= a
  // bare checkout before the UI sub-project has been built), the
  // resolver must still surface a deterministic path so downstream
  // `hostStatic(...)` doesn't crash on undefined. ESM module namespaces
  // are not spyable, so we doMock `node:fs` and re-import the plugin
  // inside the doMock scope so its `existsSync` reference is the mock。
  // Reset before doMock so the next import of `./index.ts` re-evaluates
  // the module against the patched `node:fs` namespace。
  vi.resetModules();
  vi.doMock("node:fs", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    return {
      ...actual,
      existsSync: () => false,
    };
  });
  try {
    const { default: unworkletMocked } = (await import("./index.ts")) as {
      default: typeof unworklet;
    };
    const plugin = unworkletMocked();
    const setup = (plugin as unknown as { devtools?: { setup: (ctx: unknown) => void } }).devtools
      ?.setup;
    const ctx = makeDevToolsCtxStub();
    setup!(ctx);
    expect(ctx.views.__hostStaticCalls).toHaveLength(1);
    const root = ctx.views.__hostStaticCalls[0]!.root;
    // The fallback path is the first candidate (= `<plugin-dir>/ui`)。
    expect(root.endsWith("/ui")).toBe(true);
  } finally {
    vi.doUnmock("node:fs");
    vi.resetModules();
  }
});

test("devtools.setup registers a single dock entry at the `/__unworklet/` static SPA root", () => {
  const plugin = unworklet();
  const setup = (plugin as unknown as { devtools?: { setup: (ctx: unknown) => void } }).devtools
    ?.setup;
  const ctx = makeDevToolsCtxStub();
  setup!(ctx);
  expect(ctx.docks.__registerCalls).toHaveLength(1);
  const dock = ctx.docks.__registerCalls[0] as {
    id: string;
    title: string;
    type: string;
    url: string;
  };
  expect(dock).toMatchObject({
    id: "unworklet",
    title: "unworklet",
    type: "iframe",
    url: "/__unworklet/",
  });
  expect(ctx.views.__hostStaticCalls).toHaveLength(1);
  expect(ctx.views.__hostStaticCalls[0]!.urlBase).toBe("/__unworklet/");
});

test("devtools.setup wires the graph + live-state shared states and their update RPCs", async () => {
  const plugin = unworklet();
  const setup = (plugin as unknown as { devtools?: { setup: (ctx: unknown) => Promise<void> } })
    .devtools?.setup;
  const ctx = makeDevToolsCtxStub();
  // The wiring is async (lazy devtools-kit import + shared-state gets), so await
  // the setup before asserting the RPC side effects.
  await setup!(ctx);
  expect(ctx.rpc.__sharedStateGets).toContain("unworklet:graph");
  expect(ctx.rpc.__sharedStateGets).toContain("unworklet:state");
  const registered = ctx.rpc.__registerCalls.map((f) => (f as { name: string }).name);
  expect(registered).toContain("unworklet:graph-update");
  expect(registered).toContain("unworklet:state-update");
});
