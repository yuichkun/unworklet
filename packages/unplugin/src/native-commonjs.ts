import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileFunction } from "node:vm";

import type { DevEnvironment } from "vite-plus";

export const isCommonJsFile = async (file: string): Promise<boolean> => {
  if (file.endsWith(".cjs")) return true;
  if (!file.endsWith(".js")) return false;
  let directory = path.dirname(file);
  for (;;) {
    if (path.basename(directory) === "node_modules") break;
    const manifest = path.join(directory, "package.json");
    if (existsSync(manifest)) {
      const text = (await readFile(manifest, "utf8")).replace(/^\uFEFF/, "");
      const { type } = JSON.parse(text) as { type?: string };
      if (type === "commonjs") return true;
      if (type === "module") return false;
      break;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const source = await readFile(file, "utf8");
  try {
    // Parse without execution using Node's CommonJS wrapper bindings. Ambiguous
    // .js files with ESM-only syntax must stay inside the fresh SSR graph.
    compileFunction(source, ["exports", "require", "module", "__filename", "__dirname"]);
    return true;
  } catch {
    return false;
  }
};

export const preserveNativeCommonJs = (environment: DevEnvironment): void => {
  const fetchModule = environment.fetchModule.bind(environment);
  // SSR's default evaluator treats local CommonJS as ESM. Keeping it native
  // preserves require(), wrapper globals, and the complete cached namespace.
  environment.fetchModule = async (url, importer, options) => {
    const resolved = await environment.pluginContainer.resolveId(url, importer);
    if (resolved) {
      const id = resolved.id;
      const file = id.startsWith("file:") ? fileURLToPath(id) : id.split(/[?#]/)[0]!;
      if (path.isAbsolute(file) && (await isCommonJsFile(file))) {
        return {
          externalize: id.startsWith("file:")
            ? id
            : pathToFileURL(file).href + id.slice(file.length),
          type: "commonjs",
        };
      }
    }
    return fetchModule(url, importer, options);
  };
};
