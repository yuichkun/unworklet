import { encodeWav } from "@unworklet/offline";
import { expect, test, vi } from "vite-plus/test";
import { createWavLoader } from "./sound-check-loader.ts";
const audio = () =>
  new Response(Uint8Array.from(encodeWav([new Float32Array([0.5])], 48000)).buffer);

test("reads PCM and distinguishes missing, HTTP, network and malformed responses", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(audio())
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(new Response(null, { status: 403 }))
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValueOnce(new Response("bad"));
  const load = createWavLoader(fetcher);
  const signal = new AbortController().signal;
  expect((await load("good", signal))?.channels[0]?.[0]).toBe(0.5);
  expect(await load("missing", signal)).toBeNull();
  await expect(load("http", signal)).rejects.toThrow("HTTP 403");
  await expect(load("network", signal)).rejects.toThrow("network error");
  await expect(load("malformed", signal)).rejects.toThrow("unreadable WAV");
});

test("bounds all outstanding requests to six and discards aborted queued work", async () => {
  const finish: (() => void)[] = [];
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(() => new Promise((resolve) => finish.push(() => resolve(audio()))));
  const load = createWavLoader(fetcher);
  const controller = new AbortController();
  const pending = Array.from({ length: 12 }, (_, i) =>
    load(String(i), controller.signal).catch(() => null),
  );
  expect(fetcher).toHaveBeenCalledTimes(6);
  controller.abort();
  for (const done of finish) done();
  await Promise.all(pending);
  expect(fetcher).toHaveBeenCalledTimes(6);
  const next = load("next", new AbortController().signal);
  expect(fetcher).toHaveBeenCalledTimes(7);
  finish.at(-1)!();
  expect(await next).not.toBeNull();
});
