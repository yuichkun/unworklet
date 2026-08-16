/**
 * Behavioral tests for the build-time graph capture context (= Step 3.1
 * implementation in `./capture.ts`, plan Q-B module-level mutable global).
 *
 * Every branch of every helper is covered: `runCapture` install /
 * restore (including the throw path), the `addStatement` top-level vs
 * loop-body branch, the `getCurrentCapture` outside-of-capture guard,
 * the wrap / unwrap brand, and the prototype dispatch table.
 */

import { expect, test } from "vite-plus/test";

import type { AstNode } from "./ast.ts";
import {
  addDeclaration,
  addStatement,
  finalize,
  getCurrentCapture,
  newCaptureContext,
  registerNodeMethod,
  runCapture,
  unwrapAst,
  wrapAst,
} from "./capture.ts";

test("`newCaptureContext` returns an empty context with no loop body", () => {
  const ctx = newCaptureContext();
  expect(ctx.declarations).toEqual([]);
  expect(ctx.statements).toEqual([]);
  expect(ctx.currentLoopBody).toBeNull();
});

test("`getCurrentCapture` throws outside `runCapture`", () => {
  expect(() => getCurrentCapture()).toThrow(/outside `defineProcessor` body/);
});

test("`runCapture` installs the context, runs the callback, and restores afterward", () => {
  const ctx = newCaptureContext();
  let observed: ReturnType<typeof getCurrentCapture> | null = null;
  const result = runCapture(ctx, () => {
    observed = getCurrentCapture();
    return 42;
  });
  expect(result).toBe(42);
  expect(observed).toBe(ctx);
  expect(() => getCurrentCapture()).toThrow();
});

test("`runCapture` restores the previous context even when the callback throws", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      throw new Error("boom");
    }),
  ).toThrow("boom");
  expect(() => getCurrentCapture()).toThrow();
});

test("nested `runCapture` restores the outer context on exit", () => {
  const outer = newCaptureContext();
  const inner = newCaptureContext();
  runCapture(outer, () => {
    expect(getCurrentCapture()).toBe(outer);
    runCapture(inner, () => {
      expect(getCurrentCapture()).toBe(inner);
    });
    expect(getCurrentCapture()).toBe(outer);
  });
});

test("`addStatement` appends to `statements` when no loop body is active", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    addStatement({ kind: "loopCounter" });
    addStatement({ kind: "literal", type: "f32", value: 1 });
  });
  expect(ctx.statements).toEqual([
    { kind: "loopCounter" },
    { kind: "literal", type: "f32", value: 1 },
  ]);
  expect(ctx.declarations).toEqual([]);
});

test("`addStatement` appends to `currentLoopBody` when one is active", () => {
  const ctx = newCaptureContext();
  const loopBody: AstNode[] = [];
  runCapture(ctx, () => {
    ctx.currentLoopBody = loopBody;
    addStatement({ kind: "loopCounter" });
  });
  expect(loopBody).toEqual([{ kind: "loopCounter" }]);
  expect(ctx.statements).toEqual([]);
});

test("`addDeclaration` appends to `declarations`", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    addDeclaration({ kind: "audioInput", name: "main", channels: 2 });
  });
  expect(ctx.declarations).toEqual([{ kind: "audioInput", name: "main", channels: 2 }]);
});

test("`addStatement` / `addDeclaration` throw outside `runCapture`", () => {
  expect(() => addStatement({ kind: "loopCounter" })).toThrow();
  expect(() => addDeclaration({ kind: "audioInput", name: "x", channels: 1 })).toThrow();
});

test("`wrapAst` carries the AST payload, recoverable via `unwrapAst`", () => {
  const ast: AstNode = { kind: "literal", type: "f32", value: 3 };
  const wrapped = wrapAst(ast);
  expect(unwrapAst(wrapped)).toBe(ast);
});

test("`unwrapAst` throws on objects without the AST payload", () => {
  expect(() => unwrapAst({} as never)).toThrow(/AST payload/);
});

test("`unwrapAst` throws a friendly diagnostic when given undefined", () => {
  // Simulates a subgraph method with a missing `return`, or a helper chain that
  // returned undefined — the value flows into a DSL primitive at graph capture
  // and the raw property access would throw an opaque `Cannot read properties of
  // undefined (reading 'Symbol(unworklet.astPayload)')`.
  expect(() => unwrapAst(undefined as never)).toThrow(
    /expected a Node<T>.*received undefined.*missing `return`|`.next\(\)`/s,
  );
});

test("`unwrapAst` throws a friendly diagnostic when given null / a factory handle", () => {
  // null path.
  expect(() => unwrapAst(null as never)).toThrow(/received null.*missing `return`/s);
  // A plain function (e.g. someone forgot to CALL the factory, or passed the
  // factory itself instead of its output) — reaches unwrapAst as a non-object.
  expect(() => unwrapAst(((): void => {}) as never)).toThrow(
    /received a function.*missing `return`|`.next\(\)`/s,
  );
});

test("`registerNodeMethod` extends the shared `Node` prototype for wrapped values", () => {
  registerNodeMethod("__captureTestMethod", function method(this: unknown) {
    return this;
  });

  const wrapped = wrapAst({ kind: "loopCounter" });
  const dispatched = (wrapped as unknown as Record<string, () => unknown>)["__captureTestMethod"]();

  expect(dispatched).toBe(wrapped);
});

test("`finalize` returns the declarations + statements snapshot", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    addDeclaration({ kind: "audioInput", name: "main", channels: 1 });
    addStatement({ kind: "loopCounter" });
  });
  expect(finalize(ctx)).toEqual({
    declarations: [{ kind: "audioInput", name: "main", channels: 1 }],
    statements: [{ kind: "loopCounter" }],
  });
});
