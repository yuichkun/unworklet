// Bundle the AudioWorklet runtime (engine + all examples) into a single
// self-contained .js file in public/. Vite then serves it as /worklet.js.
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

await build({
  entryPoints: [path.join(root, "src/audio/worklet-runtime.ts")],
  outfile: path.join(root, "public/unworklet-worklet.js"),
  bundle: true,
  format: "iife",
  target: "es2022",
  platform: "browser",
  legalComments: "none",
  sourcemap: false,
  minify: true,
  // Disable esbuild's class-name preservation helper (`__name`) which depends on
  // a runtime symbol that is not present in AudioWorkletGlobalScope.
  keepNames: false,
  // Suppress the named-class transform that introduces `__name` calls.
  supported: {
    "class-field": true,
    "class-static-field": true,
    "class-private-field": true,
    "class-private-static-field": true,
    "class-private-method": true,
  },
  logLevel: "info",
});

console.log("Worklet bundle written to public/unworklet-worklet.js");
