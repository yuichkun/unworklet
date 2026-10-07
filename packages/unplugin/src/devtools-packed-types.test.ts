import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { expect, test } from "vite-plus/test";

const repo = path.resolve(import.meta.dirname, "../../..");
const pluginRoot = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);

test("packed DevTools declarations work with the optional kit absent and present", () => {
  expect(
    existsSync(path.join(pluginRoot, "dist/index.d.mts")),
    "Build unplugin before checking its packed declarations",
  ).toBe(true);
  const dir = mkdtempSync(path.join(tmpdir(), "unworklet-devtools-types-"));
  try {
    const modules = path.join(dir, "node_modules");
    mkdirSync(modules);
    for (const name of ["core", "lang", "unplugin"]) {
      const packageRoot =
        name === "unplugin"
          ? pluginRoot
          : path.dirname(require.resolve(`@unworklet/${name}/package.json`));
      execFileSync(
        path.join(repo, "node_modules/.bin/vp"),
        ["pm", "pack", "--pack-destination", dir],
        { cwd: packageRoot, stdio: "pipe", timeout: 30_000 },
      );
      const archive = readdirSync(dir).find(
        (file) => file.startsWith(`unworklet-${name}-`) && file.endsWith(".tgz"),
      )!;
      const target = path.join(modules, "@unworklet", name);
      mkdirSync(target, { recursive: true });
      execFileSync("tar", ["-xf", path.join(dir, archive), "--strip-components=1", "-C", target]);
      expect(existsSync(path.join(target, "src"))).toBe(false);
    }
    for (const name of ["devframe", "typescript", "unplugin", "vite", "@types"])
      symlinkSync(path.join(pluginRoot, "node_modules", name), path.join(modules, name));
    symlinkSync(
      path.join(
        path.dirname(require.resolve("@unworklet/lang/package.json")),
        "node_modules/@volar",
      ),
      path.join(modules, "@volar"),
    );
    symlinkSync(
      path.join(
        path.dirname(require.resolve("@unworklet/core/package.json")),
        "node_modules/binaryen",
      ),
      path.join(modules, "binaryen"),
    );
    writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
    const file = path.join(dir, "index.ts");
    const options: ts.CompilerOptions = {
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      types: [],
    };
    const check = (source: string): string[] => {
      writeFileSync(file, source);
      const program = ts.createProgram([file], options);
      const diagnostics = ts.getPreEmitDiagnostics(program);
      const errors = diagnostics.map(
        (diagnostic) =>
          `${diagnostic.file?.fileName}:${diagnostic.start}: TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
      );
      expect(
        program
          .getSourceFiles()
          .some(
            (source) =>
              source.fileName.startsWith(path.join(pluginRoot, "src")) ||
              source.fileName.includes("devtools-ui/src"),
          ),
      ).toBe(false);
      return errors;
    };
    expect(
      ts.resolveModuleName("@vitejs/devtools-kit", file, options, ts.sys).resolvedModule,
    ).toBeUndefined();
    expect(
      ts.resolveModuleName("@unworklet/unplugin", file, options, ts.sys).resolvedModule
        ?.resolvedFileName,
    ).toBe(path.join(modules, "@unworklet/unplugin/dist/index.d.mts"));
    expect(check('import unworklet from "@unworklet/unplugin"; unworklet();')).toEqual([]);
    mkdirSync(path.join(modules, "@vitejs"));
    symlinkSync(
      path.dirname(require.resolve("@vitejs/devtools-kit/package.json")),
      path.join(modules, "@vitejs/devtools-kit"),
    );
    // The optional SDK ships platform declaration errors; opting in must add none.
    const baseline = check(
      'import type {} from "@unworklet/unplugin"; import type {} from "@vitejs/devtools-kit"; import type {} from "@vitejs/devtools-kit/client";',
    );
    const augmented = check(
      readFileSync(new URL("./devtools-consumer.ts.txt", import.meta.url), "utf8"),
    );
    expect(augmented).toEqual(baseline);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
