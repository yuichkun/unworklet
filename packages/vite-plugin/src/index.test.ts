/**
 * `unworklet` Vite plugin factory shape + `?worklet` resolve / load hooks
 * (= `07-vite-plugin.md` + `10-roadmap.md` Phase 5)。 5-B = factory が real
 * Vite `Plugin` object を 返 す こ と + 5-C = `?worklet` query を 持 つ
 * source を virtual id に 解 決、 virtual id を 受 け た load が JS module を
 * 返 す こ と を 担 保。 hook の 中 で 走 る `compile()` invocation + WASM
 * emit は 5-D で fill = 5-C の load は placeholder JS module を 返 す。
 */

import { expect, test } from "vite-plus/test";

import unworklet, { unworkletPlugin } from "./index.ts";

type ResolveIdFn = (
  this: unknown,
  source: string,
  importer: string | undefined,
  options: { isEntry: boolean },
) => unknown;

type LoadFn = (this: unknown, id: string) => unknown;

const callResolveId = (source: string, importer: string | undefined): unknown => {
  const hook = unworklet().resolveId;
  if (typeof hook !== "function") {
    throw new Error("resolveId hook is not a function — expected plain function form");
  }
  return (hook as unknown as ResolveIdFn).call(null, source, importer, { isEntry: false });
};

const callLoad = (id: string): unknown => {
  const hook = unworklet().load;
  if (typeof hook !== "function") {
    throw new Error("load hook is not a function — expected plain function form");
  }
  return (hook as unknown as LoadFn).call(null, id);
};

const NUL = String.fromCharCode(0);
const VIRTUAL_ID_PREFIX = `${NUL}unworklet:`;

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
// 5-C = ?worklet load
// ─────────────────────────────────────────────────────────────────────────

test("load returns a placeholder JS module for virtual `\\0unworklet:` ids", () => {
  const code = callLoad(`${VIRTUAL_ID_PREFIX}/abs/foo.processor.ts`);
  expect(typeof code).toBe("string");
  expect(code as string).toMatch(/export default/);
});

test("load returns undefined for non-virtual ids", () => {
  expect(callLoad("/abs/foo.processor.ts")).toBeUndefined();
  expect(callLoad(`${NUL}vite:client`)).toBeUndefined();
  expect(callLoad(`${NUL}other-prefix:/abs/x.ts`)).toBeUndefined();
});
