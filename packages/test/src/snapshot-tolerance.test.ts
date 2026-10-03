import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeWav } from "@unworklet/offline";
import { afterEach, expect, test } from "vite-plus/test";
import { expectAudioMatchesSnapshot } from "./index.ts";

const dirs: string[] = [];
function options() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "uwk-snap-"));
  dirs.push(dir);
  return { snapshotPath: path.join(dir, "sound.wav"), sampleRate: 48000, tolerance: 1e-5 };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});
const signal = () => new Float32Array(128).fill(0.25);

test("tolerance: a later run within tolerance passes", async () => {
  const opts = options();
  writeFileSync(opts.snapshotPath, encodeWav([signal()], opts.sampleRate));
  await expectAudioMatchesSnapshot(
    signal().map((v) => v + 5e-6),
    opts,
  );
});
test("tolerance: one sample beyond tolerance fails and names it", async () => {
  const opts = options();
  const x = signal();
  writeFileSync(opts.snapshotPath, encodeWav([x], opts.sampleRate));
  x[100]! += 2e-5;
  await expect(expectAudioMatchesSnapshot(x, opts)).rejects.toThrow(/sample 100.*tolerance/);
});
test("tolerance: a sample-rate mismatch fails even when samples match", async () => {
  const opts = options();
  writeFileSync(opts.snapshotPath, encodeWav([signal()], opts.sampleRate));
  await expect(
    expectAudioMatchesSnapshot(signal(), { ...opts, sampleRate: 44100 }),
  ).rejects.toThrow(/sampleRate/);
});
test("tolerance: a length mismatch fails", async () => {
  const opts = options();
  writeFileSync(opts.snapshotPath, encodeWav([signal()], opts.sampleRate));
  await expect(expectAudioMatchesSnapshot(new Float32Array(129), opts)).rejects.toThrow(/length/);
});
test("tolerance: a channel count mismatch fails", async () => {
  const opts = options();
  writeFileSync(opts.snapshotPath, encodeWav([signal()], opts.sampleRate));
  await expect(expectAudioMatchesSnapshot([signal(), signal()], opts)).rejects.toThrow(
    /channel count/,
  );
});
test.each([NaN, Infinity, -Infinity])(
  "tolerance: a stored non-finite sample fails (%s)",
  async (value) => {
    const opts = options();
    const x = signal();
    x[100] = value;
    writeFileSync(opts.snapshotPath, encodeWav([x], 48000));
    await expect(expectAudioMatchesSnapshot(signal(), opts)).rejects.toThrow(
      /sample 100.*(NaN|Infinity)/,
    );
  },
);
test.each([NaN, Infinity, -Infinity])(
  "tolerance: actual non-finite sample fails (%s)",
  async (value) => {
    const opts = options();
    writeFileSync(opts.snapshotPath, encodeWav([signal()], opts.sampleRate));
    const x = signal();
    x[100] = value;
    await expect(expectAudioMatchesSnapshot(x, opts)).rejects.toThrow(/sample 100.*(NaN|Infinity)/);
  },
);
test.each([undefined, 0])("no tolerance stays byte-exact (%s)", async (tolerance) => {
  const opts = { ...options(), tolerance };
  const x = signal();
  writeFileSync(opts.snapshotPath, encodeWav([x], opts.sampleRate));
  x[100]! += 2 ** -25;
  await expect(expectAudioMatchesSnapshot(x, opts)).rejects.toThrow(/byte .* mismatch/);
});
test("tolerance: the exact boundary passes and the next float fails", async () => {
  const opts = { ...options(), tolerance: 2 ** -16 };
  writeFileSync(opts.snapshotPath, encodeWav([new Float32Array([0])], opts.sampleRate));
  await expectAudioMatchesSnapshot(new Float32Array([opts.tolerance]), opts);
  await expect(
    expectAudioMatchesSnapshot(new Float32Array([opts.tolerance + 2 ** -39]), opts),
  ).rejects.toThrow(/sample 0.*tolerance/);
});
