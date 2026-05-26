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

type EmitFileArgs = {
  type: "asset";
  name: string;
  source: Uint8Array | string;
};

type MockEmitContext = {
  calls: EmitFileArgs[];
  refId: string;
  emitFile: (file: EmitFileArgs) => string;
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
  const ctx: MockEmitContext = {
    calls: [],
    refId: "mock-ref-id",
    emitFile(file) {
      ctx.calls.push(file);
      return ctx.refId;
    },
  };
  const result = await (hook as unknown as LoadFn).call(ctx, id);
  return { result, ctx };
};

const callLoadNoContext = async (id: string): Promise<unknown> => {
  const hook = unworklet().load;
  if (typeof hook !== "function") {
    throw new Error("load hook is not a function — expected plain function form");
  }
  return await (hook as unknown as LoadFn).call(null, id);
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

  const wasmCall = ctx.calls.find((c) => c.name.endsWith(".wasm"));
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

  const wasmCall = ctx.calls.find((c) => c.name.endsWith(".wasm"));
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
  expect(gainCtx.calls.find((c) => c.name.endsWith(".wasm"))).toMatchObject({
    name: "01-stereo-gain.wasm",
  });

  const { ctx: bareCtx } = await callLoadWithMockContext(
    `${VIRTUAL_ID_PREFIX}${FIXTURE_BARE_GAIN_PATH}`,
  );
  expect(bareCtx.calls.find((c) => c.name.endsWith(".wasm"))).toMatchObject({
    name: "bare-gain.wasm",
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5-E = 4 metadata artifact JSON emit
// ─────────────────────────────────────────────────────────────────────────

test("load also emits 4 metadata artifact JSON files by default", async () => {
  const { ctx } = await callLoadWithMockContext(`${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`);

  const names = ctx.calls.map((c) => c.name).sort();
  expect(names).toEqual([
    "01-stereo-gain.diagnostics.json",
    "01-stereo-gain.graph.json",
    "01-stereo-gain.memory.json",
    "01-stereo-gain.schema-hash.json",
    "01-stereo-gain.wasm",
  ]);
});

test("each emitted metadata JSON file parses to a valid JSON value", async () => {
  const { ctx } = await callLoadWithMockContext(`${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`);

  const byName = (n: string) => ctx.calls.find((c) => c.name === n);
  expect(() => JSON.parse(byName("01-stereo-gain.graph.json")!.source as string)).not.toThrow();
  expect(() => JSON.parse(byName("01-stereo-gain.memory.json")!.source as string)).not.toThrow();
  expect(() =>
    JSON.parse(byName("01-stereo-gain.diagnostics.json")!.source as string),
  ).not.toThrow();
  const sh = JSON.parse(byName("01-stereo-gain.schema-hash.json")!.source as string) as {
    schemaHash: unknown;
  };
  expect(typeof sh.schemaHash).toBe("string");
});

test("emitted schema-hash JSON carries the same hash that compile() returned", async () => {
  const { ctx } = await callLoadWithMockContext(`${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`);
  const fixtureModule = (await import(FIXTURE_GAIN_PATH)) as Record<string, unknown>;
  const direct = await compile(fixtureModule["stereoGain"] as Parameters<typeof compile>[0]);

  const shCall = ctx.calls.find((c) => c.name === "01-stereo-gain.schema-hash.json");
  expect(JSON.parse(shCall!.source as string)).toEqual({ schemaHash: direct.schemaHash });
});

test("`emitAnalysisArtifacts: false` suppresses the 4 metadata JSON emits", async () => {
  const { ctx } = await callLoadWithMockContext(`${VIRTUAL_ID_PREFIX}${FIXTURE_GAIN_PATH}`, {
    emitAnalysisArtifacts: false,
  });

  expect(ctx.calls).toHaveLength(1);
  expect(ctx.calls[0]).toMatchObject({ name: "01-stereo-gain.wasm" });
});
