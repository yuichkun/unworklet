/**
 * Liveness of the per-file `?worklet` witness in the REAL editor protocol: a
 * tsserver loads a consumer project and reports `node.params.<...>` completions.
 * When the processor's params change and the plugin re-emits the witness `.d.ts`,
 * the completions must update WITHOUT restarting the server — this is the
 * "does dev-time completion actually refresh?" question answered against the
 * same tsserver an editor drives, not a static type assertion.
 *
 * The two witnesses are built from two REAL compiled processors (param `gain`
 * vs param `cutoff`), so the rename is the one the declarations produce.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

import { audioOutput, defineProcessor, forSample, param } from "@unworklet/core";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

import { workletDts } from "@unworklet/lang";

const UNPLUGIN = path.resolve(import.meta.dirname, "..");
const REPO = path.resolve(UNPLUGIN, "../..");
const CORE = path.join(REPO, "packages/core");
const TSSERVER = path.join(UNPLUGIN, "node_modules/typescript/lib/tsserver.js");

const SPECIFIER = "*/gain.processor.ts?worklet";

/** A processor with one named param + a stereo output, the param name varied. */
const makeProc = (paramName: string) =>
  defineProcessor(() => {
    const p = param.f32({ default: 1, min: 0, max: 4, automationRate: "a-rate" }).named(paramName);
    const out = audioOutput({ channels: 2, name: "main" });
    return {
      process: () => {
        forSample((i) => {
          out.left.at(i).write(p.at(i));
        });
      },
    };
  });

const MAIN = `/// <reference types="@unworklet/unplugin/client" />
/// <reference path="./gain.worklet.d.ts" />
import { createNode } from "@unworklet/core";
import proc from "./gain.processor.ts?worklet";
declare const ctx: BaseAudioContext;
export async function f(): Promise<void> {
  const node = await createNode(ctx, proc);
  node.params.SLOT;
}
`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 1-based { line, offset } of the character at `index` in `text`. */
function at(text: string, index: number): { line: number; offset: number } {
  const before = text.slice(0, index);
  return { line: before.split("\n").length, offset: index - before.lastIndexOf("\n") };
}

/** Minimal tsserver protocol client (newline requests, Content-Length responses). */
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

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "uwk-worklet-live-"));
  mkdirSync(path.join(dir, "node_modules/@unworklet"), { recursive: true });
  symlinkSync(UNPLUGIN, path.join(dir, "node_modules/@unworklet/unplugin"));
  symlinkSync(CORE, path.join(dir, "node_modules/@unworklet/core"));
  writeFileSync(
    path.join(dir, "tsconfig.json"),
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
      include: ["."],
    }),
  );
  // Initial witness: param `gain`.
  writeFileSync(
    path.join(dir, "gain.worklet.d.ts"),
    workletDts(SPECIFIER, makeProc("gain").worklet),
  );
  writeFileSync(path.join(dir, "main.ts"), MAIN);
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Poll `node.params.<here>` member completions until `want` appears (or give up). */
async function paramsCompletionsUntil(
  server: TsServer,
  mainPath: string,
  want: string,
): Promise<string[]> {
  const pos = at(MAIN, MAIN.indexOf("node.params.") + "node.params.".length);
  let names: string[] = [];
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    const r = await server.request<{ entries: { name: string }[] }>("completionInfo", {
      file: mainPath,
      line: pos.line,
      offset: pos.offset,
    });
    names = (r.body?.entries ?? []).map((e) => e.name);
    if (names.includes(want)) break;
  }
  return names;
}

test("node.params completions refresh when the witness is re-emitted (no restart)", async () => {
  const server = new TsServer(dir);
  try {
    const mainPath = path.join(dir, "main.ts");
    server.notify("open", { file: mainPath, fileContent: MAIN, scriptKindName: "TS" });

    const before = await paramsCompletionsUntil(server, mainPath, "gain");
    expect(before).toContain("gain");
    expect(before).not.toContain("cutoff");

    // The processor's param is renamed; the plugin re-emits the witness d.ts.
    // No reloadProjects — the editor picks the change up through its own file
    // watch, which is what makes dev-time completion refresh on its own.
    writeFileSync(
      path.join(dir, "gain.worklet.d.ts"),
      workletDts(SPECIFIER, makeProc("cutoff").worklet),
    );

    const after = await paramsCompletionsUntil(server, mainPath, "cutoff");
    expect(after).toContain("cutoff");
    expect(after).not.toContain("gain");
  } finally {
    server.dispose();
  }
}, 60_000);
