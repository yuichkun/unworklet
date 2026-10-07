import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { marked, type Tokens } from "marked";
import { expect, test } from "vite-plus/test";

import { validateGuideCitations } from "./guide-cites.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const GUIDE_DIR = path.join(REPO, "skills/unworklet");

function guideReferenceFiles(markdown: string): string[] {
  const locations = markdown
    .replace(/(\[cite:\s*[\w./-]+\.[A-Za-z0-9_-]+\s*::\s*)`[^`]+`(\s*\])/g, "$1`excerpt`$2")
    .replace(/<(pre|code|script|style|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "");
  const prose: string[] = [];
  void marked.walkTokens(marked.lexer(locations), (token) => {
    if (
      (token.type === "text" && !("tokens" in token && token.tokens)) ||
      (token.type === "codespan" && !token.text.includes("[cite:"))
    ) {
      prose.push(token.text);
    }
    if (token.type === "link") prose.push(token.href);
    if (token.type === "html")
      prose.push(
        token.raw
          .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
          .replace(/<(pre|code|script|style|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ""),
      );
  });
  return prose.flatMap((text) =>
    [
      ...text.matchAll(
        /\b(?:packages|examples|scripts)\/[\w./-]*\.[A-Za-z0-9_-]+|(?<![\w/])README\.md\b/g,
      ),
    ].map(([file]) => file),
  );
}

test.each([
  '[cite: scripts/check.ts :: `const target = "packages/core/src/index.ts";`]',
  '<div>[cite: scripts/check.ts :: `const target = "packages/core/src/index.ts";`]</div>',
])("the evidence backstop distinguishes cited files from paths in excerpts: %s", (markdown) => {
  expect(guideReferenceFiles(markdown)).toEqual(["scripts/check.ts"]);
});

test.each([
  "```text\npackages/lang/src/unworklet-tsc.ts:12\n```",
  "> ```text\n> packages/lang/src/unworklet-tsc.ts:12\n> ```",
  "- Diagnostic\n\n  ```text\n  packages/lang/src/unworklet-tsc.ts:12\n  ```",
  "    packages/lang/src/unworklet-tsc.ts:12",
  "Use ``[cite: packages/example.ts :: `placeholder`]`` as the syntax.",
  "Text <!-- [cite: packages/example.ts :: `placeholder`] --> continues.",
  "<pre><code>[cite: packages/example.ts :: `placeholder`]</code></pre>",
  "<template>[cite: packages/example.ts :: `placeholder`]</template>",
  "Syntax: <code>[cite: packages/example.ts :: `placeholder`]</code>.",
  "<!-- [cite: packages/example.ts :: `placeholder`]",
])("the evidence backstop excludes fenced and indented diagnostics: %s", (markdown) => {
  expect(guideReferenceFiles(markdown)).toEqual([]);
});

test.each([
  "See `packages/lang/src/unworklet-tsc.ts`.",
  "[source](packages/lang/src/unworklet-tsc.ts)",
  "| Source |\n| --- |\n| [compiler][source] |\n\n[source]: packages/lang/src/unworklet-tsc.ts",
])("the evidence backstop retains prose and linked repository paths: %s", (markdown) => {
  expect(guideReferenceFiles(markdown)).toContain("packages/lang/src/unworklet-tsc.ts");
});

test("the authoring-form reference identifies both successful client import cases", () => {
  const guide = readFileSync(path.join(GUIDE_DIR, "setup.md"), "utf8");
  const section = guide.split("## 4. File conventions")[1]!.split("## 5.")[0]!;
  expect(section).toContain('expect(diagnose("with-ref.ts")).toEqual([]);');
  expect(section).toContain('expect(diagnose("with-ref-uwk.ts")).toEqual([]);');
});

test("runner-import references identify the actual imports", () => {
  const guide = readFileSync(path.join(GUIDE_DIR, "testing.md"), "utf8");
  for (const source of [
    "examples/demo/src/examples.render.test.ts",
    "packages/test/src/index.test.ts",
  ]) {
    expect(guide).toContain(
      `[cite: ${source} :: \`import { expect, test } from "vite-plus/test";\`]`,
    );
  }
});

test("the lowpass example points to the demonstrated lowpass test", () => {
  const guide = readFileSync(path.join(GUIDE_DIR, "testing.md"), "utf8");
  expect(guide).toContain(
    '[cite: examples/demo/src/examples.render.test.ts :: `test("lowpass: a step input ramps smoothly toward it ($prev feedback works)"`]',
  );
});

test("browser API references identify browser entry points", () => {
  const guide = readFileSync(path.join(GUIDE_DIR, "dsl.md"), "utf8");
  expect(guide).toContain(
    "[cite: packages/lang/src/browser.ts :: `export function lowerToProcessor(`]",
  );
  expect(guide).toContain(
    "[cite: packages/lang/src/browser.ts :: `export async function compileSource(`]",
  );
  expect(guide).toContain("[cite: packages/lang/src/index.ts :: `export { lower, LowerError }`]");
});

test("guide citations stay visible instead of becoming Markdown reference definitions", () => {
  for (const name of readdirSync(GUIDE_DIR).filter((file) => file.endsWith(".md"))) {
    const tokens = marked.lexer(readFileSync(path.join(GUIDE_DIR, name), "utf8"));
    expect(
      Object.keys(tokens.links).filter((label) => label.startsWith("cite:")),
      name,
    ).toEqual([]);
  }
});

test("slot exposure and events render as separate headings and fenced examples", () => {
  const markdown = readFileSync(path.join(GUIDE_DIR, "dsl.md"), "utf8");
  const html = marked.parse(markdown, { async: false });
  expect(html).toContain("<h3>Slot exposure — <code>ExposeOptions</code></h3>");
  expect(html).toContain("<h3>Events — <code>event&lt;T&gt;</code> (typed message ports)</h3>");
  expect(html).toContain('<pre><code class="language-ts">type ExposeOptions = {');
  expect(html).toContain("<li><code>publish</code> is allowed only on");
  const examples = marked
    .lexer(markdown)
    .filter((token): token is Tokens.Code => token.type === "code");
  expect(examples.filter((token) => token.text.startsWith("type ExposeOptions ="))).toEqual([
    expect.objectContaining({ lang: "ts", text: expect.not.stringContaining("- `publish`") }),
  ]);
  expect(examples.filter((token) => token.text.startsWith("event<T>({ from:"))).toEqual([
    expect.objectContaining({ lang: "ts", text: expect.not.stringContaining("Inbound") }),
  ]);
});

test("every explicit guide citation and full repository-file reference resolves to current evidence", () => {
  const guides = readdirSync(GUIDE_DIR).filter((name) => name.endsWith(".md"));
  const errors: string[] = [];
  let references = 0;
  for (const name of guides) {
    const markdown = readFileSync(path.join(GUIDE_DIR, name), "utf8");
    const checked = new Set<string>();
    errors.push(
      ...validateGuideCitations(markdown, (file) => {
        checked.add(file);
        const target = path.join(REPO, file);
        return existsSync(target) ? readFileSync(target, "utf8") : undefined;
      }).map((error) => `${name} → ${error}`),
    );
    // All repository evidence in the shipped guides must reach the reader;
    // Markdown tokenization must not silently drop a migrated reference.
    for (const file of guideReferenceFiles(markdown)) {
      expect(checked.has(file), `${name} → unchecked ${file}`).toBe(true);
    }
    references += checked.size;
  }
  expect(errors).toEqual([]);
  expect(references).toBeGreaterThan(50);
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
