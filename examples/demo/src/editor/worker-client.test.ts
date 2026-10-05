import { expect, test, vi } from "vite-plus/test";
import { EditorWorkerClient } from "./worker-client.ts";
import type { WorkerRequest, WorkerResponse } from "./protocol.ts";

function setup() {
  const requests: WorkerRequest[] = [];
  const worker = {
    postMessage: (request: WorkerRequest) => requests.push(request),
    terminate: vi.fn(),
    onmessage: null as ((event: MessageEvent<WorkerResponse>) => void) | null,
    onerror: null as (() => void) | null,
    onmessageerror: null as (() => void) | null,
  };
  const fail = vi.fn();
  const client = new EditorWorkerClient(worker as unknown as Worker, fail);
  const respond = (id: number, uri = "file:///one.uwk.ts", version = 1) =>
    worker.onmessage?.({
      data: { id, result: { uri, version, diagnostics: [] } },
    } as unknown as MessageEvent<WorkerResponse>);
  client.update({ uri: "file:///one.uwk.ts", version: 1, source: "a" });
  return { worker, fail, client, requests, respond };
}

test("current response resolves and the worker is disposed exactly once", async () => {
  const { client, respond, worker } = setup();
  const pending = client.query("diagnostics", 0);
  respond(1);
  expect(await pending).toMatchObject({ version: 1 });
  client.dispose();
  client.dispose();
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});
test("new source version invalidates pending work before an old response arrives", async () => {
  const { client, respond } = setup();
  const pending = client.query("diagnostics", 0);
  client.update({ uri: "file:///one.uwk.ts", version: 2, source: "b" });
  expect(await pending).toBeUndefined();
  respond(1);
  client.dispose();
});
test("example switches reject responses even when model versions match", async () => {
  const { client, respond } = setup();
  const pending = client.query("hover", 0);
  client.update({ uri: "file:///two.uwk.ts", version: 1, source: "c" });
  respond(1);
  expect(await pending).toBeUndefined();
  client.dispose();
});
test("cancellation rejects its result without killing editor assistance", async () => {
  const { client, respond } = setup();
  let cancel: (() => void) | undefined;
  const dispose = vi.fn();
  const pending = client.query("hover", 0, {
    isCancellationRequested: false,
    onCancellationRequested: (listener: () => void) => {
      cancel = listener;
      return { dispose };
    },
  });
  cancel!();
  respond(1);
  expect(await pending).toBeUndefined();
  expect(dispose).toHaveBeenCalledOnce();
  client.dispose();
});
test("worker crashes settle all requests and report failure without throwing", async () => {
  const { client, worker, fail } = setup();
  const pending = client.query("completion", 0);
  worker.onerror!();
  expect(await pending).toBeUndefined();
  expect(fail).toHaveBeenCalledOnce();
  expect(await client.query("hover", 0)).toBeUndefined();
});
test("worker timeout fails closed and releases pending requests", async () => {
  vi.useFakeTimers();
  const { client, fail } = setup();
  const pending = client.query("diagnostics", 0);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await pending).toBeUndefined();
  expect(fail).toHaveBeenCalledOnce();
  vi.useRealTimers();
});

test("a source-specific worker error can recover on the next document", async () => {
  const { client, worker, fail, respond } = setup();
  const pending = client.query("completion", 0);
  worker.onmessage!({
    data: { id: 1, error: "incomplete source" },
  } as MessageEvent<WorkerResponse>);
  expect(await pending).toBeUndefined();
  expect(fail).toHaveBeenCalledWith(expect.stringContaining("incomplete source"), false);
  client.update({ uri: "file:///one.uwk.ts", version: 2, source: "fixed" });
  const next = client.query("diagnostics", 0);
  respond(2, "file:///one.uwk.ts", 2);
  expect(await next).toMatchObject({ version: 2 });
  client.dispose();
});

test("already cancelled requests never enter the worker queue", async () => {
  const { client, requests } = setup();
  expect(
    await client.query("completion", 0, {
      isCancellationRequested: true,
      onCancellationRequested: vi.fn(),
    }),
  ).toBeUndefined();
  expect(requests).toEqual([]);
  client.dispose();
});

test("worker responses with an unrelated document identity are ignored", async () => {
  const { client, respond } = setup();
  const pending = client.query("hover", 0);
  respond(1, "file:///unrelated.uwk.ts", 1);
  expect(await pending).toBeUndefined();
  client.dispose();
});
