/**
 * Rewraps Node's raw `ERR_MODULE_NOT_FOUND` when the cause is an extensionless
 * relative import inside a processor module (issue #41).
 *
 * Dev evaluates processor sources through `ssrLoadModule` (full Vite
 * resolution), but the build path evaluates them through native `import()`,
 * where Node ESM resolution applies — and it demands explicit file extensions.
 * The raw error names neither that rule nor the fix, so the author gets a
 * debugging session for a one-character suffix. This wrap states the rule and,
 * when a sibling file makes the intent obvious, the exact specifier to write.
 *
 * Unit-tested directly: inside the test runtime the runner intercepts dynamic
 * `import()` and resolves Vite-style, so the native failure cannot be
 * reproduced end-to-end in-process.
 */

import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Candidate suffixes an extensionless Vite-style relative import usually means
 * under Node ESM resolution.
 */
const EXTENSION_CANDIDATES = [".ts", ".tsx", ".mts", ".js", ".mjs", "/index.ts", "/index.js"];

export const withExtensionHint = (err: unknown): unknown => {
  const e = err as { code?: string; message?: string };
  if (e?.code !== "ERR_MODULE_NOT_FOUND" || typeof e.message !== "string") return err;
  const m = /Cannot find module '([^']+)' imported from ([^\s]+)/.exec(e.message);
  if (m === null) return err;
  const missing = m[1]!;
  if (path.extname(missing) !== "") return err; // a genuinely missing file, not the extension rule
  const candidate = EXTENSION_CANDIDATES.find((suffix) => existsSync(`${missing}${suffix}`));
  const fix =
    candidate !== undefined
      ? ` The file exists as "${missing}${candidate}" — write the import specifier with that suffix (e.g. "./${path.basename(missing)}${candidate}").`
      : ` Add the file extension to the import specifier (e.g. "./name.ts").`;
  return new Error(
    `@unworklet/unplugin: processor modules are evaluated with Node ESM resolution at build ` +
      `time, which requires an explicit file extension in relative imports — ` +
      `"${missing}" (imported from ${m[2]!}) does not resolve without one.${fix}`,
    { cause: err },
  );
};
