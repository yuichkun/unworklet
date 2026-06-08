/**
 * End-to-end real-consumer setup: the plugin emits `.unworklet/worklets.d.ts`
 * under the project root, and a consumer whose `vite-env.d.ts` references both
 * the client types and the generated witness gets a typed `node.params.<name>`
 * — no per-file `/// <reference>` in the source, no tsconfig edit. This is the
 * setup the docs prescribe: two references in vite-env (client + witness) plus
 * `.gitignore` for the artifact. (A bare tsconfig `include` does NOT work — a
 * wildcard ambient `declare module` only takes effect when pulled in by a
 * reference, which is why the witness is wired through vite-env.)
 *
 * Black-box: drives the real plugin hooks to write the witness, then type-checks
 * the consumer with stock TypeScript over the real tsconfig.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";

import unworklet from "./index.ts";

const VITE_PLUGIN = path.resolve(import.meta.dirname, "..");
const REPO = path.resolve(VITE_PLUGIN, "../..");
const CORE = path.join(REPO, "packages/core");
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

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "uwk-integ-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("plugin-emitted witness types node.params via tsconfig include (no per-file ref)", async () => {
  mkdirSync(path.join(root, "node_modules/@unworklet"), { recursive: true });
  symlinkSync(VITE_PLUGIN, path.join(root, "node_modules/@unworklet/vite-plugin"));
  symlinkSync(CORE, path.join(root, "node_modules/@unworklet/core"));

  // The plugin writes <root>/.unworklet/worklets.d.ts as a side effect of load.
  const plugin = unworklet();
  (plugin.configResolved as unknown as ConfigResolvedFn)({ command: "serve", root, base: "/" });
  await (plugin.load as unknown as LoadFn).call(mockCtx(), `${VIRTUAL_ID_PREFIX}${FIXTURE}`);

  // The docs setup: client reference in vite-env, `.unworklet` on the include.
  writeFileSync(
    path.join(root, "vite-env.d.ts"),
    `/// <reference types="@unworklet/vite-plugin/client" />
/// <reference path="./.unworklet/worklets.d.ts" />
`,
  );
  writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "nodenext",
        moduleResolution: "nodenext",
        customConditions: ["development"],
        allowImportingTsExtensions: true,
        lib: ["es2023", "dom"],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      },
      include: ["main.ts", "vite-env.d.ts"],
    }),
  );
  // No `/// <reference>` in the source — the witness is picked up via `include`.
  writeFileSync(
    path.join(root, "main.ts"),
    `import { createNode } from "@unworklet/core";
import gain from "./01-stereo-gain.processor.ts?worklet";
declare const ctx: BaseAudioContext;
export async function f(): Promise<void> {
  const node = await createNode(ctx, gain);
  node.params.gain.value = 0.5;
  // @ts-expect-error — undeclared param name is a type error
  void node.params.notAParam;
}
`,
  );

  const read = ts.readConfigFile(path.join(root, "tsconfig.json"), (f) => ts.sys.readFile(f));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const main = program.getSourceFiles().find((s) => s.fileName.endsWith("/main.ts"));
  if (!main) throw new Error("main.ts not in program");
  const msgs = program
    .getSemanticDiagnostics(main)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  // gain typed (no error), notAParam rejected (absorbed by @ts-expect-error).
  expect(msgs).toEqual([]);
});
