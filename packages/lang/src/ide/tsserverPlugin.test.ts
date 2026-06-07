/**
 * The real editor path, end to end. VS Code drives a `tsserver` process over its
 * JSON protocol; this test does the same — it spawns the actual `tsserver`, loads
 * the BUILT `@unworklet/lang/typescript-plugin` through a project's `tsconfig`
 * `plugins`, opens `.uwk.ts` files, and asserts the responses a real editor shows:
 * zero diagnostics on valid sugar, a real type error on a genuine mistake, hover
 * type, and member completion.
 *
 * This exercises the parts the in-process language-service tests cannot — tsserver
 * plugin RESOLUTION (which uses a legacy resolver that ignores `exports` and
 * `.cjs`, so the plugin must ship as `typescript-plugin/index.js` + a CommonJS
 * `package.json`) and ambient INCLUSION (a `node_modules` `.d.ts` only loads via
 * `files`, never `include`). Both broke the editor while the in-process tests
 * stayed green, which is why this lives here.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

import { build } from "esbuild";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

const LANG = path.resolve(import.meta.dirname, "../..");
const REPO = path.resolve(LANG, "../..");
const CORE = path.join(REPO, "packages/core");
const TS_DIR = path.join(LANG, "node_modules/typescript");
const TSSERVER = path.join(TS_DIR, "lib/tsserver.js");

const VALID = `const input = audioInput({ channels: 2 });
const out = audioOutput({ channels: 2 });
const gain = param.f32({ default: 1, min: 0, max: 4, automationRate: "a-rate" });
process(() => {
  forSample((i) => {
    const l = input.left[i] * gain[i];
    out.left[i] = l;
    out.right[i] = input.right[i] * gain[i];
  });
});`;

const BROKEN = `const out = audioOutput({ channels: 2 });
const gate = state.bool(false).named();
process(() => {
  forSample((i) => {
    out.left[i] = gate;
  });
});`;

let dir: string;

/** A minimal tsserver protocol client: newline-delimited requests, Content-Length
 * framed responses; correlate by `request_seq`. */
class TsServer {
  private readonly proc: ChildProcessByStdio<Writable, Readable, null>;
  private seq = 0;
  private buf = "";
  private readonly waiters = new Map<number, (m: { body?: unknown }) => void>();

  constructor(cwd: string) {
    this.proc = spawn("node", [TSSERVER], { cwd, stdio: ["pipe", "pipe", "ignore"] });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => {
      this.buf += chunk;
      for (;;) {
        const header = this.buf.match(/Content-Length: (\d+)\r\n\r\n/);
        if (!header) break;
        const start = header.index! + header[0].length;
        const end = start + Number(header[1]);
        if (this.buf.length < end) break;
        const body = this.buf.slice(start, end);
        this.buf = this.buf.slice(end);
        let msg: { type?: string; request_seq?: number; body?: unknown };
        try {
          msg = JSON.parse(body);
        } catch {
          continue;
        }
        if (msg.type === "response" && msg.request_seq !== undefined) {
          this.waiters.get(msg.request_seq)?.(msg);
          this.waiters.delete(msg.request_seq);
        }
      }
    });
  }

  request<T = unknown>(command: string, args: unknown): Promise<{ body?: T }> {
    const s = ++this.seq;
    const wait = new Promise<{ body?: T }>((res) => this.waiters.set(s, res as never));
    this.proc.stdin.write(
      `${JSON.stringify({ seq: s, type: "request", command, arguments: args })}\n`,
    );
    return wait;
  }

  notify(command: string, args: unknown): void {
    this.proc.stdin.write(
      `${JSON.stringify({ seq: ++this.seq, type: "request", command, arguments: args })}\n`,
    );
  }

  dispose(): void {
    this.proc.kill();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 1-based { line, offset } of the character at `index` in `text`. */
function at(text: string, index: number): { line: number; offset: number } {
  const before = text.slice(0, index);
  return { line: before.split("\n").length, offset: index - before.lastIndexOf("\n") };
}

beforeAll(async () => {
  // Build the plugin into its shipped on-disk shape (the legacy-resolvable
  // `typescript-plugin/index.js` + CommonJS marker), so tsserver can load it.
  mkdirSync(path.join(LANG, "typescript-plugin"), { recursive: true });
  await build({
    entryPoints: [path.join(LANG, "src/typescript-plugin.ts")],
    outfile: path.join(LANG, "typescript-plugin/index.js"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    external: ["typescript"],
    footer: { js: "module.exports = module.exports.default;" },
    logLevel: "silent",
  });
  writeFileSync(
    path.join(LANG, "typescript-plugin/package.json"),
    `${JSON.stringify({ type: "commonjs" })}\n`,
  );

  // A throwaway consumer project: node_modules symlinks to the real packages and a
  // tsconfig that registers ONLY the plugin (no `files`). The plugin auto-injects
  // the shipped ambient `.d.ts`, so `plugins` is the entire setup.
  dir = mkdtempSync(path.join(tmpdir(), "uwk-tsserver-"));
  mkdirSync(path.join(dir, "node_modules/@unworklet"), { recursive: true });
  symlinkSync(LANG, path.join(dir, "node_modules/@unworklet/lang"));
  symlinkSync(CORE, path.join(dir, "node_modules/@unworklet/core"));
  writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "nodenext",
        moduleResolution: "nodenext",
        customConditions: ["development"],
        allowImportingTsExtensions: true,
        lib: ["es2023"],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        plugins: [{ name: "@unworklet/lang/typescript-plugin" }],
      },
      include: ["."],
    }),
  );
  writeFileSync(path.join(dir, "valid.uwk.ts"), VALID);
  writeFileSync(path.join(dir, "broken.uwk.ts"), BROKEN);
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

type Diag = { text: string };

test("a real tsserver loads the plugin and type-checks .uwk.ts sugar end to end", async () => {
  const server = new TsServer(dir);
  try {
    const validPath = path.join(dir, "valid.uwk.ts");
    const brokenPath = path.join(dir, "broken.uwk.ts");
    server.notify("open", { file: validPath, fileContent: VALID, scriptKindName: "TS" });

    // Wait for the project to load and the plugin to attach. Poll the valid file:
    // before the plugin is live, the raw sugar reports errors; once live, none.
    let validDiags: Diag[] = [{ text: "pending" }];
    for (let i = 0; i < 20 && validDiags.length > 0; i++) {
      await sleep(500);
      const r = await server.request<Diag[]>("semanticDiagnosticsSync", { file: validPath });
      validDiags = r.body ?? [];
    }
    expect(validDiags).toEqual([]); // valid sugar — no @ts-nocheck, no errors

    // Hover on `l` (a sugar-multiplied binding) reports the desugared Node type.
    const lPos = at(VALID, VALID.indexOf("const l =") + "const ".length);
    const qi = await server.request<{ displayString?: string }>("quickinfo", {
      file: validPath,
      line: lPos.line,
      offset: lPos.offset,
    });
    expect(qi.body?.displayString).toContain('Node<"f32">');

    // Completion after `input.` offers the stereo channel-view members.
    const cPos = at(VALID, VALID.indexOf("input.left") + "input.".length);
    const comp = await server.request<{ entries: { name: string }[] }>("completionInfo", {
      file: validPath,
      line: cPos.line,
      offset: cPos.offset,
    });
    const names = (comp.body?.entries ?? []).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["left", "right", "ch"]));

    // A genuine type error (bool Node written to an f32 output) surfaces, mapped
    // back onto the author's `.uwk.ts`.
    server.notify("open", { file: brokenPath, fileContent: BROKEN, scriptKindName: "TS" });
    await sleep(500);
    const broken = await server.request<Diag[]>("semanticDiagnosticsSync", { file: brokenPath });
    const texts = (broken.body ?? []).map((d) => d.text);
    expect(texts.some((t) => t.includes('Node<"bool">') && t.includes('Node<"f32">'))).toBe(true);
  } finally {
    server.dispose();
  }
});
