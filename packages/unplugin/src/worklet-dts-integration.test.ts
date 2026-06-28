/**
 * End-to-end real-consumer setup, with NO `vite-env.d.ts` — the type wiring is
 * pure `tsconfig.json`, so it is bundler-agnostic. Two supported shapes:
 *
 *  1. **extends** (the default): the plugin writes `.unworklet/tsconfig.json`
 *     carrying `types` (the `?worklet` ambient), `plugins` (the `.uwk.ts` editor
 *     checker), and an `include` that pulls the generated `.unworklet/worklets.d.ts`
 *     (the per-processor type file). The consumer adds one line — `extends` — and
 *     `node.params.<name>` is typed.
 *  2. **manual** (the escape hatch, for projects that can't extend): the consumer
 *     writes the same three settings into their own tsconfig directly.
 *
 * Black-box: drives the real plugin hooks, then type-checks the consumer with
 * stock TypeScript over the real tsconfig. The per-processor type file is the
 * single `.unworklet/worklets.d.ts` the plugin regenerates; it is listed once and
 * grows as processors are added — no tsconfig edit per processor.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";

import unworklet from "./index.ts";

const UNPLUGIN = path.resolve(import.meta.dirname, "..");
const REPO = path.resolve(UNPLUGIN, "../..");
const CORE = path.join(REPO, "packages/core");
const LANG = path.join(REPO, "packages/lang");
const FIXTURE = fileURLToPath(
  new URL("../__fixtures__/01-stereo-gain.processor.ts", import.meta.url),
);
const VIRTUAL_ID_PREFIX = "\0unworklet:";

type ConfigResolvedFn = (config: { command: string; root: string; base: string }) => void;
type LoadFn = (this: { emitFile: () => string; addWatchFile: () => void }, id: string) => unknown;
const mockCtx = (): { emitFile: () => string; addWatchFile: () => void } => ({
  emitFile: () => "ref",
  addWatchFile: () => {},
});

// A realistic consumer compilerOptions — what an app already owns. The generated
// tsconfig contributes only the unworklet-specific bits (`types` / `plugins`),
// which merge on top of these.
const APP_COMPILER_OPTIONS = {
  module: "nodenext",
  moduleResolution: "nodenext",
  customConditions: ["development"],
  allowImportingTsExtensions: true,
  lib: ["es2023", "dom"],
  strict: true,
  noEmit: true,
  skipLibCheck: true,
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "uwk-integ-"));
  mkdirSync(path.join(root, "node_modules/@unworklet"), { recursive: true });
  symlinkSync(UNPLUGIN, path.join(root, "node_modules/@unworklet/unplugin"));
  symlinkSync(CORE, path.join(root, "node_modules/@unworklet/core"));
  symlinkSync(LANG, path.join(root, "node_modules/@unworklet/lang"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Drive the plugin so it writes `.unworklet/`, then write the app's `main.ts`. */
async function emitAndWriteMain(): Promise<void> {
  const plugin = unworklet();
  (plugin.configResolved as unknown as ConfigResolvedFn)({ command: "serve", root, base: "/" });
  await (plugin.load as unknown as LoadFn).call(mockCtx(), `${VIRTUAL_ID_PREFIX}${FIXTURE}`);
  writeFileSync(
    path.join(root, "main.ts"),
    `import { createNode } from "@unworklet/core";
import gain from "./01-stereo-gain.processor.ts?worklet";
declare const ctx: BaseAudioContext;
export async function f(): Promise<void> {
  const node = await createNode(ctx, gain);
  node.params.gain.value = 0.5;
  // @ts-expect-error — an undeclared param name is a type error
  void node.params.notAParam;
}
`,
  );
}

function diagnose(): string[] {
  const read = ts.readConfigFile(path.join(root, "tsconfig.json"), (f) => ts.sys.readFile(f));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const main = program.getSourceFiles().find((s) => s.fileName.endsWith("/main.ts"));
  if (!main) throw new Error(`main.ts not in program (files: ${parsed.fileNames.join(", ")})`);
  return program
    .getSemanticDiagnostics(main)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

test("extends: the plugin's generated tsconfig types node.params with a one-line extends", async () => {
  await emitAndWriteMain();
  // The consumer adds ONE line to their own tsconfig — no vite-env, no per-file ref.
  // Their own compilerOptions stay; the generated config adds types + plugins +
  // the include that pulls `.unworklet/worklets.d.ts`.
  writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      extends: "./.unworklet/tsconfig.json",
      compilerOptions: APP_COMPILER_OPTIONS,
    }),
  );
  expect(diagnose()).toEqual([]);
});

test("manual escape hatch: types + plugins + include the type file, no extends, no vite-env", async () => {
  await emitAndWriteMain();
  // A project that can't extend writes the three settings into its own tsconfig.
  writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        ...APP_COMPILER_OPTIONS,
        types: ["@unworklet/unplugin/client"],
        plugins: [{ name: "@unworklet/lang/typescript-plugin" }],
      },
      // The generated type file is listed explicitly — a glob skips the dot-folder.
      include: ["main.ts", ".unworklet/worklets.d.ts"],
    }),
  );
  expect(diagnose()).toEqual([]);
});
