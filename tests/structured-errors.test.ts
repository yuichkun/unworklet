// Verify structured Layer 2 / Layer 3 errors carry their code, message,
// and refactor hint per docs/03-compiler.md §2.4.
import { expect, test } from "vite-plus/test";
import { UnworkletCompileError, L2 } from "@unworklet/compiler";

test("UnworkletCompileError formats with hint", () => {
  const e = new UnworkletCompileError({
    layer: 2,
    code: "test-code",
    message: "test message",
    refactorHint: "do thing X",
  });
  expect(e.layer).toBe(2);
  expect(e.code).toBe("test-code");
  expect(e.message).toContain("L2-capture/test-code");
  expect(e.message).toContain("test message");
  expect(e.message).toContain("hint: do thing X");
});

test("L2 helper throws structured errors", () => {
  expect(() => L2.forSampleStrideNotConst()).toThrow(UnworkletCompileError);
  try {
    L2.duplicateOutputWrite(0, "main");
  } catch (e: any) {
    expect(e.layer).toBe(2);
    expect(e.code).toBe("duplicate-output-write");
    expect(e.refactorHint).toContain("Combine the two writes");
  }
});

test("L2.declarationOutsideScope throws with refactor hint", () => {
  try {
    L2.declarationOutsideScope("state.f32");
  } catch (e: any) {
    expect(e.layer).toBe(2);
    expect(e.code).toBe("decl-outside-scope");
    expect(e.refactorHint).toContain("Move the state.f32");
  }
});
