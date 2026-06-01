import { expect, test } from "vite-plus/test";

import { layout, type LiveGraph } from "./useLiveGraph";

const COL_W = 210;
const COL_X0 = 60;

const colOf = (x: number): number => Math.round((x - COL_X0) / COL_W);

test("layout: empty graph → no placed nodes", () => {
  expect(layout({ nodes: [], edges: [] })).toEqual([]);
});

test("layout: a linear chain places each node one column deeper", () => {
  const g: LiveGraph = {
    nodes: [
      { id: "a", label: "a", kind: "standard", audioNodeType: "G" },
      { id: "b", label: "b", kind: "standard", audioNodeType: "G" },
      { id: "c", label: "c", kind: "standard", audioNodeType: "G" },
    ],
    edges: [
      { id: "a>b", from: "a", to: "b" },
      { id: "b>c", from: "b", to: "c" },
    ],
  };
  const placed = layout(g);
  const col = Object.fromEntries(placed.map((n) => [n.id, colOf(n.x)]));
  expect(col).toEqual({ a: 0, b: 1, c: 2 });
});

test("layout: a node sits at its LONGEST path from a source (diamond)", () => {
  // a → b → d  and  a → d : d's column is the longest path (3), not the short one.
  const g: LiveGraph = {
    nodes: [
      { id: "a", label: "a", kind: "standard", audioNodeType: "G" },
      { id: "b", label: "b", kind: "standard", audioNodeType: "G" },
      { id: "d", label: "d", kind: "standard", audioNodeType: "G" },
    ],
    edges: [
      { id: "a>b", from: "a", to: "b" },
      { id: "b>d", from: "b", to: "d" },
      { id: "a>d", from: "a", to: "d" },
    ],
  };
  const col = Object.fromEntries(layout(g).map((n) => [n.id, colOf(n.x)]));
  expect(col.a).toBe(0);
  expect(col.b).toBe(1);
  expect(col.d).toBe(2);
});

test("layout: nodes sharing a column are packed into distinct rows", () => {
  const g: LiveGraph = {
    nodes: [
      { id: "a", label: "a", kind: "standard", audioNodeType: "G" },
      { id: "b", label: "b", kind: "standard", audioNodeType: "G" },
    ],
    edges: [],
  };
  const placed = layout(g);
  // Both are sources (column 0); their y must differ.
  expect(colOf(placed[0]!.x)).toBe(0);
  expect(colOf(placed[1]!.x)).toBe(0);
  expect(placed[0]!.y).not.toBe(placed[1]!.y);
});
