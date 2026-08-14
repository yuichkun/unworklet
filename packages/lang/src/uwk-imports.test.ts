import { expect, test } from "vite-plus/test";

import {
  plainTsModuleSpecifiers,
  rewriteImportSpecifiers,
  uwkImportSpecifiers,
} from "./uwk-imports.ts";

test("uwkImportSpecifiers returns only .uwk.ts import specifiers", () => {
  const src =
    `import { defineProcessor } from "@unworklet/core";\n` +
    `import { onepole } from "./onepole.uwk.ts";\n` +
    `import { TWO_PI } from "./constants.ts";\n` +
    `// import { decoy } from "./decoy.uwk.ts";\n` +
    `export default defineProcessor(() => ({ process: () => {} }));\n`;
  expect(uwkImportSpecifiers(src)).toEqual(["./onepole.uwk.ts"]);
});

test("rewriteImportSpecifiers replaces only mapped specifiers, AST-precise", () => {
  const src =
    `import { onepole } from "./onepole.uwk.ts";\n` +
    `import { TWO_PI } from "./constants.ts";\n` +
    `const label = "./onepole.uwk.ts";\n` +
    `export default onepole;\n`;
  const out = rewriteImportSpecifiers(src, {
    "./onepole.uwk.ts": "./.onepole.uwk.ts.abcd1234.uwklowered.ts",
  });
  expect(out).toContain('from "./.onepole.uwk.ts.abcd1234.uwklowered.ts"');
  // the constants import is untouched
  expect(out).toContain('from "./constants.ts"');
  // the string literal (not an import) is NOT rewritten
  expect(out).toContain('const label = "./onepole.uwk.ts"');
});

// A barrel re-exports a subgraph library (`export { onepole } from
// "./onepole.uwk.ts"`), which parses as an ExportDeclaration — a shape neither
// discovery nor rewriting saw while they walked imports alone.
// Reported by @codex on #43.
test("uwkImportSpecifiers and rewriteImportSpecifiers cover re-exports too", () => {
  const src =
    `export { onepole } from "./onepole.uwk.ts";\n` +
    `export * from "./tone.uwk.ts";\n` +
    `export type { Cfg } from "./cfg.uwk.ts";\n` +
    `export { plain } from "./plain.ts";\n` +
    `export {};\n`;
  // `export type { Cfg } from …` is absent on purpose: TypeScript erases the
  // statement, so it names no module at runtime and lowering it would only
  // invite a cycle that does not exist in the module graph Node sees.
  expect(uwkImportSpecifiers(src)).toEqual(["./onepole.uwk.ts", "./tone.uwk.ts"]);

  const out = rewriteImportSpecifiers(src, {
    "./onepole.uwk.ts": "./.onepole.uwk.ts.aaaa1111.uwklowered.mjs",
    "./tone.uwk.ts": "./.tone.uwk.ts.bbbb2222.uwklowered.mjs",
  });
  expect(out).toContain('from "./.onepole.uwk.ts.aaaa1111.uwklowered.mjs"');
  expect(out).toContain('export * from "./.tone.uwk.ts.bbbb2222.uwklowered.mjs"');
  // A type-only re-export keeps its modifier, and an unmapped one is untouched.
  expect(out).toContain('export type { Cfg } from "./cfg.uwk.ts"');
  expect(out).toContain('from "./plain.ts"');
});

// The emit, not the source, decides what Node is asked to load: a type-only or
// unused binding is dropped, and `import { type A }` marks the specifier rather
// than the clause. Reported by @codex on #43.
test("plainTsModuleSpecifiers reports what the emit actually references", () => {
  const emitted =
    `import { GAIN } from "./constants.ts";\n` +
    `export { helper } from "./helper.mts";\n` +
    `import "./side-effect.cts";\n` +
    `import { pkg } from "some-package";\n` +
    `import { local } from "./already.mjs";\n` +
    `console.log(GAIN, pkg, local);\n`;
  expect(plainTsModuleSpecifiers(emitted)).toEqual([
    "./constants.ts",
    "./helper.mts",
    "./side-effect.cts",
  ]);
  expect(plainTsModuleSpecifiers(`export const k = 1;\n`)).toEqual([]);
});

// Discovery treats a dynamic `import("./voice.uwk.ts")` as a dependency and
// lowers it, so a rewriter that only touched declarations left the module
// pointing at the raw `.uwk.ts` — with a temp written for it that nothing used.
// Reported by @codex on #43.
test("rewriteImportSpecifiers rewrites dynamic imports, in both literal spellings", () => {
  const src =
    `const a = () => import("./onepole.uwk.ts");\n` +
    "const b = () => import(`./tone.uwk.ts`);\n" +
    `async function c() { return (await import("./deep.uwk.ts")).x; }\n` +
    `const skip = (n) => import(\`./gen-\${n}.uwk.ts\`);\n` +
    `const label = "./onepole.uwk.ts";\n`;
  const out = rewriteImportSpecifiers(src, {
    "./onepole.uwk.ts": "./.onepole.aaaa.uwklowered.mjs",
    "./tone.uwk.ts": "./.tone.bbbb.uwklowered.mjs",
    "./deep.uwk.ts": "./.deep.cccc.uwklowered.mjs",
  });
  expect(out).toContain(`import("./.onepole.aaaa.uwklowered.mjs")`);
  expect(out).toContain(`import("./.tone.bbbb.uwklowered.mjs")`);
  expect(out).toContain(`import("./.deep.cccc.uwklowered.mjs")`);
  // An interpolated template names nothing knowable, and a string that is not a
  // specifier is not one.
  expect(out).toContain("`./gen-${n}.uwk.ts`");
  expect(out).toContain(`const label = "./onepole.uwk.ts"`);
});

test("uwkImportSpecifiers finds dynamic and query-bearing worklet dependencies", () => {
  const src =
    `import { a } from "./a.uwk.ts?rev=1";\n` +
    `const b = () => import("./b.uwk.ts");\n` +
    "const c = () => import(`./c.uwk.ts`);\n" +
    `const d = () => import(\`./d-\${x}.uwk.ts\`);\n`;
  expect(uwkImportSpecifiers(src)).toEqual(["./a.uwk.ts?rev=1", "./b.uwk.ts", "./c.uwk.ts"]);
});
