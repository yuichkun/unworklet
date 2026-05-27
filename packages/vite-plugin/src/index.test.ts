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
import { expect, test } from "vite-plus/test";

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
  // Processor name = `<exportName>__<sha8(absSourcePath)>` to dodge
  // `registerProcessor` collisions across unrelated files that share an
  // export identifier。 Suffix is deterministic per source path。
  expect(js).toMatch(/processorName:\s*"stereoGain__[0-9a-f]{8}"/);
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
  expect(aName).toMatch(/^stereoGain__[0-9a-f]{8}$/);
  expect(bName).toMatch(/^stereoGain__[0-9a-f]{8}$/);
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

test("load on a WORKLET_ENTRY_PREFIX id returns the worklet runtime template", async () => {
  const result = await callLoadNoContext(`\0unworklet-worklet:${FIXTURE_GAIN_PATH}`);

  expect(typeof result).toBe("string");
  const js = result as string;
  expect(js).toContain("extends AudioWorkletProcessor");
  expect(js).toContain("registerProcessor");
  expect(js).toContain("worklet.initialize");
  expect(js).toContain("worklet.process");
  expect(js).toContain("worklet.parameterDescriptors");
});

test("resolveId passes through WORKLET_ENTRY_PREFIX ids without modification", () => {
  const id = `\0unworklet-worklet:/abs/x.processor.ts`;
  expect(callResolveId(id, undefined)).toBe(id);
});

// ─────────────────────────────────────────────────────────────────────────
// Dev mode (= command === "serve") = middleware URL emission
// ─────────────────────────────────────────────────────────────────────────

test("dev mode: load returns JS that points moduleUrl + wasmUrl at dev middleware URLs", async () => {
  const result = await callLoadInServeMode(`${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`, {
    root: "/Users/yuichkun/workspace/unworklet/examples/01-stereo-gain",
  });
  const js = result as string;
  // Dev mode must NOT use the rollup placeholder (= it doesn't get rewritten
  // when rolldown isn't bundling)。
  expect(js).not.toContain("ROLLUP_FILE_URL_");
  // Both URLs hit the plugin's dev middleware prefix (= `__unworklet/`)。
  expect(js).toMatch(/moduleUrl: "[^"]*\/__unworklet\/[^"]*\/worklet\.js"/);
  expect(js).toMatch(/wasmUrl: "[^"]*\/__unworklet\/[^"]*\/wasm"/);
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
  const match = js.match(/\/__unworklet\/([A-Za-z0-9_-]+)\/worklet\.js/);
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

test("dev middleware serves WASM bytes for an allowlisted source + the `wasm` part", async () => {
  const { plugin, middleware } = setupServeMiddleware({
    root: "/Users/yuichkun/workspace/unworklet/examples/01-stereo-gain",
  });
  await primeAllowlist(plugin, FIXTURE_GAIN_PATH);
  const encoded = Buffer.from(FIXTURE_GAIN_PATH, "utf8").toString("base64url");
  const res = makeResponseStub();
  let nextCalled = 0;
  middleware({ url: `/__unworklet/${encoded}/wasm` }, res, () => {
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
