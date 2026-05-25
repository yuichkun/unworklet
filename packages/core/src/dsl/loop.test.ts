/**
 * `forSample` / `forSample.byN` behavior (= `01-dsl.md` §10). Step 3.3
 * fills `forSample` (= per-sample loop AST node + loopCounter binding);
 * `forSample.byN` は Phase 10 SIMD で fill = throw stub 維 持。
 */

import { expect, test } from "vite-plus/test";

import type { AstNode } from "../compile/ast.ts";
import { addStatement, newCaptureContext, runCapture, unwrapAst } from "../compile/capture.ts";

import { forSample } from "./loop.ts";

test("`forSample` outside `defineProcessor` body throws", () => {
  expect(() => forSample(() => {})).toThrow(/outside `defineProcessor` body/);
});

test("`forSample(cb)` invokes the callback exactly once at graph capture", () => {
  const ctx = newCaptureContext();
  let calls = 0;
  runCapture(ctx, () => {
    forSample(() => {
      calls += 1;
    });
  });
  expect(calls).toBe(1);
});

test("`forSample(cb)` binds `i` as a `Node<'i32'>` carrying the `loopCounter` AST", () => {
  const ctx = newCaptureContext();
  let observed: AstNode | null = null;
  runCapture(ctx, () => {
    forSample((i) => {
      observed = unwrapAst(i);
    });
  });
  expect(observed).toEqual({ kind: "loopCounter" });
});

test("`forSample(cb)` appends a `forSample` AST node (stride 1) at the top of statements", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    forSample(() => {});
  });
  expect(ctx.statements).toEqual([{ kind: "forSample", stride: 1, body: [] }]);
});

test("`addStatement` inside the `forSample` callback lands in the loop body, not in top statements", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    forSample(() => {
      addStatement({ kind: "literal", type: "f32", value: 1 });
    });
  });
  expect(ctx.statements).toEqual([
    {
      kind: "forSample",
      stride: 1,
      body: [{ kind: "literal", type: "f32", value: 1 }],
    },
  ]);
});

test("nested `forSample` = inner appended to outer body, not to top statements", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    forSample(() => {
      forSample(() => {});
    });
  });
  expect(ctx.statements).toEqual([
    {
      kind: "forSample",
      stride: 1,
      body: [{ kind: "forSample", stride: 1, body: [] }],
    },
  ]);
});

test("`forSample` callback throw = currentLoopBody is restored + no statement appended", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      forSample(() => {
        throw new Error("cb boom");
      });
    }),
  ).toThrow("cb boom");
  expect(ctx.statements).toEqual([]);
  expect(ctx.currentLoopBody).toBeNull();
});

test("`forSample` cb's `everyNSamples` arg is Phase 8 待 ち = call で throws", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      forSample((_i, everyNSamples) => {
        everyNSamples(4, () => {});
      });
    }),
  ).toThrow(/not implemented/);
});

test("`forSample.byN(stride, cb)` stub throws (= Phase 10 SIMD で fill)", () => {
  expect(() => forSample.byN(4, () => {})).toThrow(/not implemented/);
});
