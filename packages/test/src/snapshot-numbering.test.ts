import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

const { files } = vi.hoisted(() => ({ files: new Map<string, Uint8Array>() }));
vi.mock("node:fs", () => ({
  existsSync: (path: string) => files.has(path),
  mkdirSync: () => undefined,
  readFileSync: (path: string) => files.get(path),
  writeFileSync: (path: string, bytes: Uint8Array) => files.set(path, bytes.slice()),
}));

import "./extend.ts";

beforeEach(() => {
  (expect.getState().snapshotState as unknown as { _updateSnapshot: string })._updateSnapshot =
    "new";
});

function checkFiles(name: string, amplitudes: number[]) {
  const entries = [...files]
    .filter(([path]) => path.includes(`__${name}_`))
    .sort(([a], [b]) => a.localeCompare(b));
  expect(entries).toHaveLength(amplitudes.length);
  for (const [i, [path, bytes]] of entries.entries()) {
    expect(path).toMatch(new RegExp(`__${i + 1}\\.wav$`));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getFloat32(bytes.length - 4, true)).toBe(amplitudes[i]);
  }
}

test("distinct", async () => {
  await expect(Float32Array.of(0.25)).toMatchAudioSnapshot();
  await expect(Float32Array.of(0.75)).toMatchAudioSnapshot();
  checkFiles("distinct", [0.25, 0.75]);
});

test("repeated", { repeats: 1 }, async () => {
  await expect(Float32Array.of(0.25)).toMatchAudioSnapshot();
  await expect(Float32Array.of(0.75)).toMatchAudioSnapshot();
  checkFiles("repeated", [0.25, 0.75]);
});

let attempts = 0;
test("retried", { retry: 1 }, async () => {
  attempts++;
  await expect(Float32Array.of(0.25)).toMatchAudioSnapshot();
  await expect(Float32Array.of(0.75)).toMatchAudioSnapshot();
  checkFiles("retried", [0.25, 0.75]);
  expect(attempts).toBe(2);
});

let updates = 0;
test("updated", { repeats: 1 }, async () => {
  const state = expect.getState().snapshotState as unknown as { _updateSnapshot: string };
  const mode = state._updateSnapshot;
  state._updateSnapshot = "all";
  try {
    const values = ++updates === 1 ? [0.25, 0.75] : [-0.5, 0.5];
    for (const value of values) await expect(Float32Array.of(value)).toMatchAudioSnapshot();
    checkFiles("updated", values);
  } finally {
    state._updateSnapshot = mode;
  }
});

for (const [name, value] of [
  ["concurrentA", 0.25],
  ["concurrentB", 0.75],
] as const) {
  test.concurrent(name, async ({ expect: localExpect }) => {
    await localExpect(Float32Array.of(value)).toMatchAudioSnapshot();
    await Promise.resolve();
    await localExpect(Float32Array.of(-value)).toMatchAudioSnapshot();
    checkFiles(name, [value, -value]);
  });
}

describe("outer", () => {
  describe("", () => {
    test("nested", { repeats: 1 }, async () => {
      await expect(Float32Array.of(0.25)).toMatchAudioSnapshot();
      await expect(Float32Array.of(0.75)).toMatchAudioSnapshot();
      checkFiles("outer_nested", [0.25, 0.75]);
    });
  });
});
