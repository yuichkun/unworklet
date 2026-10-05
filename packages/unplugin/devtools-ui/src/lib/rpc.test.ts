import { connectRemoteDevTools, parseRemoteConnection } from "@vitejs/devtools-kit/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

vi.mock("@vitejs/devtools-kit/client", () => ({
  connectRemoteDevTools: vi.fn(),
  parseRemoteConnection: vi.fn(),
}));

afterEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
});

test("panel connections share one in-flight authenticated host connection", async () => {
  const { getPanelRpc } = await import("./rpc");
  vi.mocked(parseRemoteConnection).mockReturnValue({ token: "test-host" } as never);
  let resolve!: (client: Awaited<ReturnType<typeof connectRemoteDevTools>>) => void;
  vi.mocked(connectRemoteDevTools).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const first = getPanelRpc();
  expect(getPanelRpc()).toBe(first);
  expect(parseRemoteConnection).toHaveBeenCalledTimes(1);
  expect(connectRemoteDevTools).toHaveBeenCalledExactlyOnceWith();
  const client = { sharedState: {}, call: vi.fn() } as unknown as Awaited<
    ReturnType<typeof connectRemoteDevTools>
  >;
  resolve(client);
  await expect(first).resolves.toBe(client);
  await expect(getPanelRpc()).resolves.toBe(client);
  expect(connectRemoteDevTools).toHaveBeenCalledTimes(1);
});

test("opening outside a host rejects clearly without attempting a remote connection", async () => {
  const { getPanelRpc } = await import("./rpc");
  vi.mocked(parseRemoteConnection).mockReturnValue(null);
  await expect(getPanelRpc()).rejects.toThrow("no host connection descriptor");
  await expect(getPanelRpc()).rejects.toThrow("no host connection descriptor");
  expect(parseRemoteConnection).toHaveBeenCalledTimes(1);
  expect(connectRemoteDevTools).not.toHaveBeenCalled();
});

test("host transport failures reach all consumers of the shared connection", async () => {
  const { getPanelRpc } = await import("./rpc");
  vi.mocked(parseRemoteConnection).mockReturnValue({ token: "test-host" } as never);
  const error = new Error("WebSocket connection refused");
  vi.mocked(connectRemoteDevTools).mockRejectedValue(error);
  const first = getPanelRpc();
  expect(getPanelRpc()).toBe(first);
  await expect(first).rejects.toBe(error);
});
