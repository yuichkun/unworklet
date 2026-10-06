import { expect, test } from "vite-plus/test";

import { validateGuideCitations } from "./guide-cites.ts";

const file = "packages/lang/src/unworklet-tsc.ts";
const anchor = "options.options.skipLibCheck = true;";
const cite = `[cite: ${file} :: \`${anchor}\`]`;
const read = (source: string) => (name: string) => (name === file ? source : undefined);

test("a source insertion or whitespace reflow does not invalidate a content anchor", () => {
  expect(validateGuideCitations(cite, read(anchor))).toEqual([]);
  expect(
    validateGuideCitations(cite, read(`// unrelated\n\noptions.options.skipLibCheck\n  = true;`)),
  ).toEqual([]);
});

test("removing or changing the anchored implementation fails even if the file still has enough lines", () => {
  expect(validateGuideCitations(cite, read("// unrelated\n".repeat(300)))).toEqual([
    `${file}: anchor not found: ${anchor}`,
  ]);
  expect(validateGuideCitations(cite, read("options.options.skipLibCheck = false;"))).toEqual([
    `${file}: anchor not found: ${anchor}`,
  ]);
});

test("a duplicated anchor must be made specific instead of silently choosing a location", () => {
  expect(validateGuideCitations(cite, read(`${anchor}\n${anchor}`))).toEqual([
    `${file}: anchor is ambiguous (2 matches): ${anchor}`,
  ]);
});

test("missing source and root-level README files fail", () => {
  expect(validateGuideCitations(cite, () => undefined)).toEqual([`${file}: missing file`]);
  expect(validateGuideCitations("[cite: README.md :: `## Quick start`]", () => undefined)).toEqual([
    "README.md: missing file",
  ]);
});

test("anchors support literal punctuation, brackets, semicolons and multiline citations", () => {
  const excerpt = 'runTsc(tscPath, [".uwk.ts"], (ts, options) => {';
  expect(validateGuideCitations(`[cite:\n ${file} :: \`${excerpt}\`\n]`, read(excerpt))).toEqual(
    [],
  );
});

test.each([
  `[cite: ${file} L12-34]`,
  `(${file} L12)`,
  `(\`${file}\` L12-34)`,
  `\`${file}:12\``,
  `\`${file}:12-34\``,
  `\`${file}:L12-L34\``,
  `[cite: \`${file}:12\`]`,
  "`classify.ts:120`",
  "[L97-109]",
  "[L97]",
  `\`${file}\` L12`,
  `The import is in \`${file}\`; the rationale is at \`L1692\`.`,
  `The import is in \`${file}\`; the rationale is at \`L1692\` on the hook.`,
  "`:64-84`",
  `[source](${file}#L12-L34)`,
])("numeric source locations cannot bypass validation: %s", (markdown) => {
  expect(
    validateGuideCitations(markdown, read("// still in bounds\n".repeat(2000))).join("\n"),
  ).toContain("numeric source location");
});

test.each([
  "[cite:]",
  `[cite: ${file}]`,
  `[cite: ${file} :: \`\`]`,
  `[cite: ${file} :: \`   \`]`,
  `[cite: ${file} :: \`${anchor}\``,
  `[cite: ${file} :: \`${anchor}\`; silently ignored text]`,
  `[cite: ${file} :: \`${anchor}\`] [cite: malformed]`,
  "[cite: ../outside.ts :: `anything`]",
])("malformed citations cannot become a green zero-match check: %s", (markdown) => {
  expect(validateGuideCitations(markdown, read(anchor)).join("\n")).toContain("malformed citation");
});

test("all complete citations are checked, including multiple citations on one line", () => {
  expect(
    validateGuideCitations(`${cite} ${cite.replace(anchor, "missing()")}`, read(anchor)),
  ).toEqual([`${file}: anchor not found: missing()`]);
});

test("plain full repository file references are checked outside cite markers", () => {
  expect(validateGuideCitations("See `packages/core/src/absent.ts`.", () => undefined)).toEqual([
    "packages/core/src/absent.ts: missing file",
  ]);
});

test("ordinary numbers, ports, consumer paths, and citation-like prose are not source locations", () => {
  expect(
    validateGuideCitations(
      "128 samples; http://localhost:5173; `./src/synth.uwk.ts`; [citation]",
      () => undefined,
    ),
  ).toEqual([]);
});

test.each([
  "L1/L2 cache behavior matters for DSP throughput.",
  "The `L1` and `L2` caches hold nearby data.",
  "```ts\nconst L1 = 1;\nconst L2 = L1 + 1;\n```",
  "[L1 cache](https://example.com/cache)",
  `The \`${file}\` example uses \`L1\` and \`L2\` cache.`,
])("cache terminology and code identifiers are not source citations: %s", (markdown) => {
  expect(validateGuideCitations(markdown, read(anchor))).toEqual([]);
});

test("a content anchor can itself contain a line-like identifier", () => {
  const declaration = "const L1 = 1;";
  expect(
    validateGuideCitations(`[cite: ${file} :: \`${declaration}\`]`, read(declaration)),
  ).toEqual([]);
});

test("unrelated source references in a different paragraph do not turn identifiers into locations", () => {
  expect(
    validateGuideCitations(`See \`${file}\`.\n\nThe \`L1\` cache is small.`, read(anchor)),
  ).toEqual([]);
});
