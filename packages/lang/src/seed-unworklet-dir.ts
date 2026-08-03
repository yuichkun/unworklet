import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The `.unworklet/tsconfig.json` `seedUnworkletDir` writes next to `worklets.d.ts`.
 * A consumer extends it with one line — `"extends": "./.unworklet/tsconfig.json"` —
 * and inherits the three unworklet type settings, so no `vite-env.d.ts` is needed:
 * - `types` pulls the `*?worklet` ambient (resolves the import).
 * - `plugins` runs the `.uwk.ts` editor type-checker.
 * - `include` lists `worklets.d.ts` (the per-processor types; a glob skips the
 *   dot-folder) plus the project's sources via `../**​/*.ts`.
 *
 * `extends` does NOT merge `include`, so the consumer must not declare their own
 * `include` on the extending tsconfig (it would shadow this one). Projects that
 * need their own `include` use the manual path instead (the same three settings
 * written directly). `compilerOptions` like `module` / `lib` come from the
 * consumer's tsconfig and merge on top of these.
 */
export const GENERATED_TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      types: ["@unworklet/unplugin/client"],
      plugins: [{ name: "@unworklet/lang/typescript-plugin" }],
      // Importing a subgraph from a sibling `.uwk.ts` uses the explicit `.uwk.ts`
      // specifier, which TS only allows with `allowImportingTsExtensions` (itself
      // requiring `noEmit` — this is a type layer; the bundler does the emit).
      allowImportingTsExtensions: true,
      noEmit: true,
    },
    include: ["worklets.d.ts", "../**/*.ts", "../**/*.tsx"],
    exclude: ["../node_modules"],
  },
  null,
  2,
)}\n`;

/**
 * Synchronously seed `.unworklet/` with the extended `tsconfig.json` (and an empty
 * `worklets.d.ts` if none exists yet). Idempotent — safe to call at the start of
 * every build, dev server, or type-check to bring a cold checkout up.
 *
 * MUST be synchronous and up front: Vite/Rolldown / `unworklet-tsc` reads the
 * consumer's `{ "extends": "./.unworklet/tsconfig.json" }` at start, and an async
 * write loses that race — the first `vite build` / `vite dev` / `unworklet-tsc`
 * on a fresh checkout would otherwise fail with "Cannot read file … tsconfig.json"
 * (TS5083) before anyone writes it. The tsconfig is fixed content; the witness
 * is filled in as each `?worklet` loads (by unplugin) or left empty (by
 * unworklet-tsc, which does not compile processors).
 *
 * No-op when the root doesn't exist (a synthetic unit-test config), so it never
 * materialises a placeholder tree on disk.
 */
export const seedUnworkletDir = (root: string): void => {
  if (!root || !existsSync(root)) return;
  try {
    const outDir = path.join(root, ".unworklet");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "tsconfig.json"), GENERATED_TSCONFIG);
    const witness = path.join(outDir, "worklets.d.ts");
    if (!existsSync(witness)) writeFileSync(witness, "");
  } catch {
    // Best-effort; the async writer path (unplugin's writeWorkletsWitness) warns
    // once on a real failure.
  }
};
