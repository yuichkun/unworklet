// `unworklet dev` — watches a processor source file and rebuilds the WASM +
// worklet artifacts on change. Implements docs/07-tooling §4 (hot reload).
//
// Strategy:
//   - Recompile on file change.
//   - Serve the artifacts (worklet.js, .wasm, meta.json) over an HTTP endpoint
//     plus a tiny SSE channel so a connected page can re-add the module.
//   - The new worklet uses a query string to bust caches.
//   - When the SchemaHash matches the previous build, the connected page can
//     swap modules without losing state. When it differs, the page receives
//     `schema-changed` and reloads (per docs/04 §10 reload semantics).

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import { cmdBuild } from "./commands.js";

export type DevOptions = {
  modulePath: string;
  outDir: string;
  exportName?: string;
  sampleRate?: number;
  port?: number;
};

export async function runDev(opts: DevOptions): Promise<void> {
  if (!existsSync(opts.modulePath)) {
    console.error(`[unworklet dev] module not found: ${opts.modulePath}`);
    process.exit(1);
  }
  await fs.mkdir(opts.outDir, { recursive: true });

  let lastHash = "";
  let buildToken = 0;
  const sseClients = new Set<http.ServerResponse>();
  let lastBuildArtifacts: any = null;

  async function rebuild() {
    const token = ++buildToken;
    try {
      const a = await cmdBuild({
        modulePath: opts.modulePath,
        exportName: opts.exportName,
        outDir: opts.outDir,
        sampleRate: opts.sampleRate,
      });
      if (token !== buildToken) return;
      lastBuildArtifacts = a;
      const meta = JSON.parse(await fs.readFile(a.metaPath, "utf-8"));
      const newHash = meta.schemaHash || "";
      const event =
        lastHash && newHash && lastHash !== newHash
          ? { type: "schema-changed", oldHash: lastHash, newHash }
          : { type: "reload", hash: newHash };
      lastHash = newHash;
      const payload = `data: ${JSON.stringify(event)}\n\n`;
      for (const r of sseClients) {
        try {
          r.write(payload);
        } catch {}
      }
      console.log(
        `[unworklet dev] rebuilt (${event.type}) — schemaHash=${newHash}, ${sseClients.size} client(s) notified`,
      );
    } catch (e: any) {
      console.error(`[unworklet dev] build failed:`, e?.message ?? e);
      const payload = `data: ${JSON.stringify({ type: "error", message: e?.message ?? String(e) })}\n\n`;
      for (const r of sseClients) {
        try {
          r.write(payload);
        } catch {}
      }
    }
  }

  // Initial build
  await rebuild();

  // Watch the source file (and any sibling .ts files in the same directory).
  const watchDir = path.dirname(opts.modulePath);
  let pendingTimer: NodeJS.Timeout | null = null;
  fs.watch(watchDir, { recursive: false }).then(async (watcher) => {
    for await (const event of watcher) {
      if (!event.filename || !event.filename.endsWith(".ts")) continue;
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(rebuild, 50);
    }
  }).catch((e) => {
    console.warn("[unworklet dev] watch failed:", e?.message ?? e);
  });

  // Tiny HTTP server: GET /events (SSE), GET /artifact/<file>.
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
      });
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      res.write(`data: ${JSON.stringify({ type: "hello", hash: lastHash })}\n\n`);
      return;
    }
    if (url.pathname.startsWith("/artifact/")) {
      const fname = url.pathname.slice("/artifact/".length);
      if (!lastBuildArtifacts) {
        res.writeHead(503).end("no build yet");
        return;
      }
      const map: Record<string, string> = {
        "worklet.js": lastBuildArtifacts.workletPath,
        "module.wasm": lastBuildArtifacts.wasmPath,
        "meta.json": lastBuildArtifacts.metaPath,
        "module.wat": lastBuildArtifacts.textPath,
      };
      const fp = map[fname];
      if (!fp) {
        res.writeHead(404).end("unknown artifact");
        return;
      }
      const buf = await fs.readFile(fp);
      const ctype =
        fname.endsWith(".wasm")
          ? "application/wasm"
          : fname.endsWith(".json")
            ? "application/json"
            : fname.endsWith(".js")
              ? "application/javascript"
              : "text/plain";
      res.writeHead(200, {
        "Content-Type": ctype,
        "Access-Control-Allow-Origin": "*",
      });
      res.end(buf);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" }).end(
      `<!doctype html>
<title>unworklet dev</title>
<pre>unworklet dev — module: ${opts.modulePath}
artifacts: ${opts.outDir}
endpoints:
  /events                 — SSE stream of build events
  /artifact/worklet.js    — current worklet module JS
  /artifact/module.wasm   — current WASM binary
  /artifact/meta.json     — current build metadata
  /artifact/module.wat    — text format (for debugging)
</pre>`,
    );
  });
  server.listen(opts.port ?? 5174, () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : opts.port;
    console.log(`[unworklet dev] watching ${opts.modulePath}`);
    console.log(`[unworklet dev] artifacts at ${opts.outDir}`);
    console.log(`[unworklet dev] dev server: http://127.0.0.1:${port}`);
  });
}
