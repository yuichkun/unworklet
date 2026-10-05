import { audioOutput, compile, defineProcessor, forSample, param, state } from "@unworklet/core";
import { expect, test } from "vite-plus/test";

import unworklet from "./index.ts";

const source = "/unworklet-revision-fixture/tone.processor.ts";
const processor = (name: string) =>
  defineProcessor(() => {
    const gain = param.f32({ default: 0.25, min: 0, max: 1, automationRate: "a-rate" }).named(name);
    state.i64(1n).named("counter");
    const out = audioOutput({ channels: 1, name: "main" });
    return { process: () => forSample((i) => out.ch(0).at(i).write(gain.at(i))) };
  });

async function fixture() {
  let current: Record<string, ReturnType<typeof processor>> = { tone: processor("gain") };
  const plugin = unworklet();
  await (plugin.configResolved as (config: unknown) => unknown)({
    command: "serve",
    root: "/unworklet-revision-fixture",
    base: "/",
  });
  const virtual = { id: `\0unworklet:${source}` };
  const raw = { id: source };
  const server = {
    middlewares: { use: () => {} },
    ssrLoadModule: async () => current,
    moduleGraph: {
      getModulesByFile: () => undefined,
      getModuleById: () => virtual,
      invalidateModule: () => {},
    },
  };
  (plugin.configureServer as (server: unknown) => unknown)(server);
  (plugin.resolveId as (id: string) => unknown)(`${source}?worklet`);
  const load = (id: string) =>
    (plugin.load as (this: unknown, id: string) => Promise<string>).call(
      { addWatchFile: () => {}, emitFile: () => "asset" },
      id,
    );
  const revision = async () => {
    const wrapper = await load(virtual.id);
    const hash = wrapper.match(/\?v=([0-9a-f]{8})/)![1]!;
    return {
      hash,
      wrapper,
      module: await load(`\0unworklet-worklet:${source}?v=${hash}`),
      processorName: wrapper.match(/processorName: "([^"]+)"/)![1]!,
    };
  };
  return {
    plugin,
    server,
    raw,
    virtual,
    load,
    revision,
    set: (value: typeof current) => {
      current = value;
    },
  };
}

test("metadata-only edits have distinct immutable worklet revisions with identical WASM", async () => {
  const before = processor("gain");
  const after = processor("volume");
  expect((await compile(before)).wasm).toEqual((await compile(after)).wasm);
  const f = await fixture();
  f.set({ tone: before });
  const first = await f.revision();
  f.set({ tone: after });
  const second = await f.revision();
  expect(second.hash).not.toBe(first.hash);
  expect(second.processorName).not.toBe(first.processorName);
  expect(second.module).toContain('"name":"volume"');
  expect(await f.load(`\0unworklet-worklet:${source}?v=${first.hash}`)).toBe(first.module);
  expect(first.module).toContain('"name":"gain"');
});

test("identical bigint metadata and WASM reuse their worklet revision", async () => {
  const f = await fixture();
  const first = await f.revision();
  f.set({ tone: processor("gain") });
  expect(await f.revision()).toEqual(first);
});

test("HMR retains the changed raw module alongside the compiled wrapper", async () => {
  const f = await fixture();
  const result = await (f.plugin.handleHotUpdate as (ctx: unknown) => Promise<unknown>)({
    file: source,
    modules: [f.raw],
    server: f.server,
    read: async () => "",
  });
  expect(result).toEqual(expect.arrayContaining([f.raw, f.virtual]));
});

test("export renames do not replace a retained worklet module", async () => {
  const f = await fixture();
  const first = await f.revision();
  f.set({ renamed: processor("gain") });
  const second = await f.revision();
  expect(second.hash).not.toBe(first.hash);
  expect(second.processorName).toMatch(/^renamed__/);
  expect(await f.load(`\0unworklet-worklet:${source}?v=${first.hash}`)).toBe(first.module);
});
