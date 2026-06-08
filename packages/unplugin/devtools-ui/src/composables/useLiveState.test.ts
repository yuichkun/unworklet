import { expect, test } from "vite-plus/test";

import { type LiveState, normalizeLiveState, numericOf } from "./useLiveState";

test("normalizeLiveState: undefined / empty → empty node list", () => {
  expect(normalizeLiveState(undefined)).toEqual({ nodes: [] });
  expect(normalizeLiveState({ nodes: [] })).toEqual({ nodes: [] });
});

test("normalizeLiveState: a buffer with no `data` is coerced to an empty array (regression: the panel crashed on `b.data.map`)", () => {
  // A payload from a mismatched plugin version omits `data` on buffer slots.
  const partial = {
    nodes: [
      {
        id: "n1",
        displayName: "tapeDelay",
        scalars: [{ name: "meter", kind: "state", type: "f32", value: 0.5 }],
        buffers: [{ name: "delayLine", type: "f32", length: 32768 }],
      },
    ],
  } as unknown as LiveState;
  const out = normalizeLiveState(partial);
  expect(out.nodes[0]!.buffers[0]!.data).toEqual([]);
  // Real consumers (formatHex / formatList / v-for) can now map over it safely.
  expect(() => out.nodes[0]!.buffers[0]!.data.map((b) => b)).not.toThrow();
});

test("normalizeLiveState: missing `scalars` / `buffers` arrays default to empty", () => {
  const partial = { nodes: [{ id: "n1", displayName: "x" }] } as unknown as LiveState;
  const out = normalizeLiveState(partial);
  expect(out.nodes[0]!.scalars).toEqual([]);
  expect(out.nodes[0]!.buffers).toEqual([]);
});

test("normalizeLiveState: well-formed data passes through with data intact", () => {
  const full: LiveState = {
    nodes: [
      {
        id: "n1",
        displayName: "crusher",
        scalars: [{ name: "crush", kind: "param", type: "f32", value: 10.3 }],
        buffers: [
          { name: "pattern", type: "u8", length: 4, data: [1, 2, 3, 4], downsampled: false },
        ],
      },
    ],
  };
  const out = normalizeLiveState(full);
  expect(out.nodes[0]!.buffers[0]!.data).toEqual([1, 2, 3, 4]);
  expect(out.nodes[0]!.scalars[0]!.value).toBe(10.3);
});

test("numericOf: number passes, bool → 0/1, i64 decimal string → undefined (not charted)", () => {
  expect(numericOf(1.5)).toBe(1.5);
  expect(numericOf(true)).toBe(1);
  expect(numericOf(false)).toBe(0);
  expect(numericOf("3632896")).toBeUndefined();
});
