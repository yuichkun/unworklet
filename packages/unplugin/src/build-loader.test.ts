import { afterEach, expect, test, vi } from "vite-plus/test";

import unworklet from "./index.ts";

const { createServer } = vi.hoisted(() => ({ createServer: vi.fn() }));
vi.mock("vite-plus", () => ({ createServer }));

afterEach(() => vi.resetAllMocks());

const load = (): Promise<unknown> => {
  const hook = unworklet().load as unknown as (
    this: { addWatchFile: (file: string) => void },
    id: string,
  ) => Promise<unknown>;
  return hook.call({ addWatchFile: () => {} }, "\0unworklet:/test/processor.mjs");
};

test("a failed graph evaluation keeps its diagnostic if cleanup also fails", async () => {
  const failure = new Error("helper could not be evaluated");
  const close = vi.fn().mockRejectedValue(new Error("cleanup failed"));
  createServer.mockResolvedValue({ ssrLoadModule: vi.fn().mockRejectedValue(failure), close });
  await expect(load()).rejects.toBe(failure);
  expect(close).toHaveBeenCalledTimes(1);
});

test("cleanup failure after successful evaluation is reported", async () => {
  const failure = new Error("cleanup failed");
  const close = vi.fn().mockRejectedValue(failure);
  createServer.mockResolvedValue({ ssrLoadModule: vi.fn().mockResolvedValue({}), close });
  await expect(load()).rejects.toBe(failure);
  expect(close).toHaveBeenCalledTimes(1);
});
