/**
 * `serveCompileRequests` — the Web Worker body that compiles one processor for
 * an AudioContext whose sample rate or render quantum differs from the build's.
 *
 * Node has no DedicatedWorkerGlobalScope, so each test installs the two members
 * the worker uses (`addEventListener`, `postMessage`) on `globalThis` and drives
 * the registered listener with request messages.
 */

import { afterEach, expect, test } from "vite-plus/test";

import "./dsl/primitives.ts";
import { compile } from "./compile/index.ts";
import { f32 } from "./dsl/constructors.ts";
import { audioOutput } from "./dsl/declarations.ts";
import { forSample } from "./dsl/loop.ts";
import { defineProcessor } from "./processor.ts";
import { makeWorkletNamespaceFromMeta, type WorkletMeta } from "./worklet.ts";

import { serveCompileRequests } from "./compile-worker.ts";

type Posted = { message: unknown; transfer: Transferable[] | undefined };
type Listener = (event: { data: unknown }) => void;

const scope = globalThis as unknown as Record<string, unknown>;
const installed: string[] = [];

/** Install a fake worker scope; returns the posted messages and the event log. */
function fakeWorkerScope(): { posted: Posted[]; log: string[]; send: (data: unknown) => void } {
  const posted: Posted[] = [];
  const log: string[] = [];
  const listeners: Listener[] = [];
  for (const key of ["addEventListener", "postMessage"]) {
    if (key in scope) throw new Error(`test realm already defines globalThis.${key}`);
    installed.push(key);
  }
  scope.addEventListener = (type: string, listener: Listener) => {
    log.push(`listen:${type}`);
    listeners.push(listener);
  };
  scope.postMessage = (message: unknown, transfer?: Transferable[]) => {
    log.push(`post:${(message as { type: string }).type}`);
    posted.push({ message, transfer });
  };
  return { posted, log, send: (data) => listeners.forEach((listener) => listener({ data })) };
}

afterEach(() => {
  for (const key of installed.splice(0)) delete scope[key];
});

/** Writes 1000 / ctx.sampleRate to every sample: the value shows which rate the WASM was built for. */
const rateProbe = defineProcessor((ctx) => {
  const out = audioOutput({ channels: 1, name: "main" });
  return {
    process: () => {
      forSample((i) =>
        out
          .ch(0)
          .at(i)
          .write(f32(1000 / ctx.sampleRate)),
      );
    },
  };
});

const strided = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  return {
    process: () => {
      forSample.byN(64, (i) => out.ch(0).at(i).write(f32(1)));
    },
  };
});

const RUNTIME = "/* inline worklet runtime */ globalThis.__uwkMakeNs = () => {};";

/** Resolve once the scope has posted `count` messages. */
async function settle(posted: Posted[], count: number): Promise<void> {
  for (let tries = 0; posted.length < count && tries < 500; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("serveCompileRequests posts ready only after its message listener is installed", () => {
  const { posted, log } = fakeWorkerScope();
  serveCompileRequests(rateProbe, { workletRuntime: RUNTIME });
  expect(log).toEqual(["listen:message", "post:ready"]);
  expect(posted[0]!.message).toEqual({ type: "ready" });
});

test("a compile request is answered with the target's WASM, metadata and worklet module", async () => {
  const { posted, send } = fakeWorkerScope();
  serveCompileRequests(rateProbe, { workletRuntime: RUNTIME });
  send({
    type: "compile",
    id: 7,
    sampleRate: 44100,
    renderQuantumSize: 64,
    processorName: "rateProbe@44100x64",
  });
  await settle(posted, 2);
  const reply = posted[1]!.message as {
    type: string;
    id: number;
    wasm: Uint8Array;
    meta: WorkletMeta;
    moduleSource: string;
  };
  expect(reply.type).toBe("result");
  expect(reply.id).toBe(7);
  // The bytes are those compile() builds for the same target, handed over without a copy.
  const expected = await compile(rateProbe, { sampleRate: 44100, renderQuantumSize: 64 });
  expect(Array.from(reply.wasm)).toEqual(Array.from(expected.wasm));
  expect(posted[1]!.transfer).toEqual([reply.wasm.buffer]);
  // The metadata crosses postMessage (structured clone) and describes the 64-sample layout.
  const meta = structuredClone(reply.meta);
  expect(meta.layout.renderQuantumSize).toBe(64);
  // The module is self-contained: the runtime is inlined and nothing is imported.
  expect(reply.moduleSource.startsWith(RUNTIME)).toBe(true);
  expect(reply.moduleSource).toContain('registerProcessor("rateProbe@44100x64"');
  expect(reply.moduleSource).not.toMatch(/^\s*import\s/m);

  // Run the returned WASM through a namespace built from the returned metadata:
  // its coefficients are the 44.1 kHz ones and one call fills 64 samples.
  const ns = makeWorkletNamespaceFromMeta(meta);
  const port = { postMessage: () => {}, addEventListener: () => {}, start: () => {} };
  const self = { port };
  ns.initialize(self, { processorOptions: { wasm: reply.wasm } });
  const output = new Float32Array(64);
  ns.process(self, [], [[output]], {});
  expect(Array.from(output)).toEqual(Array.from({ length: 64 }, () => Math.fround(1000 / 44100)));
});

test("a compile the target rejects is answered with an error carrying the diagnostic ID", async () => {
  const { posted, send } = fakeWorkerScope();
  serveCompileRequests(strided, { workletRuntime: RUNTIME });
  send({
    type: "compile",
    id: 3,
    sampleRate: 48000,
    renderQuantumSize: 32,
    processorName: "strided@48000x32",
  });
  await settle(posted, 2);
  expect(posted[1]!.message).toMatchObject({
    type: "error",
    id: 3,
    message: expect.stringMatching(/\[illegal-stride\]/),
  });
});

test("a processor body that throws a non-Error value for the target is answered with that value", async () => {
  // Builds at the eager 48 kHz capture, refuses 44.1 kHz the way a user check might.
  const picky = defineProcessor((ctx) => {
    if (ctx.sampleRate === 44100) throw "44.1 kHz is not supported";
    const out = audioOutput({ channels: 1, name: "main" });
    return { process: () => forSample((i) => out.ch(0).at(i).write(f32(0))) };
  });
  const { posted, send } = fakeWorkerScope();
  serveCompileRequests(picky, { workletRuntime: RUNTIME });
  send({
    type: "compile",
    id: 9,
    sampleRate: 44100,
    renderQuantumSize: 128,
    processorName: "picky@44100x128",
  });
  await settle(posted, 2);
  expect(posted[1]!.message).toEqual({
    type: "error",
    id: 9,
    message: "44.1 kHz is not supported",
  });
});

test("messages other than compile requests are ignored", async () => {
  const { posted, send } = fakeWorkerScope();
  serveCompileRequests(rateProbe, { workletRuntime: RUNTIME });
  send({ type: "unknown" });
  send(null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(posted.map((p) => (p.message as { type: string }).type)).toEqual(["ready"]);
});
