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
import { execFileSync } from "node:child_process";
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

test("every sibling guide file the guide sends a reader to exists", () => {
  // The guide routes between its own files in prose ("see dsl.md"), and renaming
  // one leaves the others pointing at nothing. A dead pointer costs a reader the
  // section it was sent to find, and nothing about the text looks wrong — so it
  // survived a rename and shipped. Reported by @codex on #43.
  const shipped = new Set(readdirSync(GUIDE_DIR).filter((f) => f.endsWith(".md")));
  const dangling: string[] = [];
  let mentions = 0;
  for (const name of shipped) {
    const text = readFileSync(path.join(GUIDE_DIR, name), "utf8");
    for (const [, target] of text.matchAll(/(?<![\w./-])([a-z][a-z-]*\.md)\b/g)) {
      mentions += 1;
      if (!shipped.has(target!)) dangling.push(`${name} → ${target!}`);
    }
  }
  expect(mentions).toBeGreaterThan(10);
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

/**
 * The tracked extensions that are supposed to contain arbitrary bytes. Everything
 * else is text and is checked below.
 *
 * Listing the binary side rather than the text side is deliberate: a new source
 * or config format is then covered the moment it lands, while adding a binary
 * asset type is a deliberate edit here. The other direction — enumerating text
 * extensions — leaves `.js`, `.vue`, `.yml`, `.css`, lockfiles and shell scripts
 * silently unguarded, which is exactly what it did.
 */
const BINARY_EXTENSIONS = new Set([".wav", ".png"]);

test("no tracked text file carries a NUL byte", () => {
  // A single NUL makes Git classify the whole file as binary: `git diff` reports
  // only "Binary files differ", so every later change to it lands unreviewable
  // and nothing about the source looks wrong. It reached a central loader module
  // as a hash delimiter written literally instead of as `\0`.
  // Reported by @codex on #43.
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "buffer" })
    .toString("utf8")
    .split("\0")
    .filter((f) => f !== "");
  expect(tracked.length).toBeGreaterThan(200);

  const text = tracked.filter((f) => !BINARY_EXTENSIONS.has(path.extname(f).toLowerCase()));
  const binary = text.filter((f) => {
    try {
      return readFileSync(path.join(REPO, f)).includes(0);
    } catch {
      return false; // a submodule entry or a path removed since `ls-files` ran
    }
  });
  expect(binary).toEqual([]);
});
