import { expect, test } from "vite-plus/test";

import { rewriteImportSpecifiers, uwkImportSpecifiers } from "./uwk-imports.ts";

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
