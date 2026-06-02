/**
 * `@unworklet/core/dev` — dev-only surface for the DevTools page bridge.
 *
 * Resolved via the `development` export condition in serve mode; production
 * apps never import this subpath, so the registry stays tree-shaken out. The
 * Vite plugin's injected page-script reads `getDevNodes()` to X-ray each live
 * node — no application code touches this.
 */

export { getDevNodes, onDevNodesChanged } from "./devRegistry.ts";
export type { DevNodeHandle } from "./devRegistry.ts";
