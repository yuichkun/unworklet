/**
 * The shipped AI guide (`skills/unworklet/`) anchors its claims with
 * `[cite: <path> L<a>-<b>]` markers. Those anchors are the guide's link to the
 * implementation — the thing that makes a claim checkable instead of folklore —
 * and they rot silently: moving a file leaves the guide pointing at nothing,
 * and a reader (human or AI) has no way to tell a stale anchor from a live one.
 *
 * So the anchors are checked here rather than trusted. A cited path must exist,
 * and a cited line range must fit inside the file it names. Content drift is not
 * something a test can catch, but a dangling path is, and that is the failure
 * mode that has actually happened.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { expect, test } from "vite-plus/test";

const REPO = path.resolve(import.meta.dirname, "..");
const GUIDE_DIR = path.join(REPO, "skills/unworklet");

/** `packages/lang/src/worklet-dts.ts L18-163` → the path and the last line cited. */
const CITE = /\[cite:([^\]]*)\]/g;
const REF =
  /((?:packages|examples|scripts)\/[A-Za-z0-9/._-]+\.[A-Za-z]+)(?:\s+L(\d+)(?:-(\d+))?)?/g;

type Ref = { file: string; path: string; lastLine: number | undefined };

function citedRefs(): Ref[] {
  const out: Ref[] = [];
  for (const name of readdirSync(GUIDE_DIR).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(path.join(GUIDE_DIR, name), "utf8");
    for (const [, body] of text.matchAll(CITE)) {
      for (const [, p, from, to] of (body ?? "").matchAll(REF)) {
        const last = to ?? from;
        out.push({ file: name, path: p!, lastLine: last === undefined ? undefined : Number(last) });
      }
    }
  }
  return out;
}

test("every path the guide cites exists", () => {
  const refs = citedRefs();
  // A zero-match regex would make this test vacuously green.
  expect(refs.length).toBeGreaterThan(20);

  const dangling = refs
    .filter((r) => !existsSync(path.join(REPO, r.path)))
    .map((r) => `${r.file} → ${r.path}`);
  expect([...new Set(dangling)]).toEqual([]);
});

test("every line range the guide cites fits inside the file it names", () => {
  const lineCount = new Map<string, number>();
  const past = citedRefs()
    .filter((r) => r.lastLine !== undefined && existsSync(path.join(REPO, r.path)))
    .filter((r) => {
      let n = lineCount.get(r.path);
      if (n === undefined) {
        n = readFileSync(path.join(REPO, r.path), "utf8").split("\n").length;
        lineCount.set(r.path, n);
      }
      return r.lastLine! > n;
    })
    .map((r) => `${r.file} → ${r.path} cites L${r.lastLine}, file has ${lineCount.get(r.path)}`);
  expect([...new Set(past)]).toEqual([]);
});
