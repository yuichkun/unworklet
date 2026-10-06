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
  `${file} (L12)`,
  `${file} line 12`,
  `${file} lines 12-34`,
  `\`${file}\` (lines 12-34)`,
  `\`${file}\`, line 12`,
  `\`${file}\`: lines 12-34`,
  `\`${file}\` at line 12`,
  `\`${file}\` lines \`12-34\``,
  `Line 12 in \`${file}\` explains the setting.`,
  `See \`${file}\`; lines 12–34 explain the setting.`,
  `\`${file}\` (L12-L34)`,
  `\`${file}\` (\`L12\`)`,
  `(\`${file}\` L12-34)`,
  `\`${file}:12\``,
  `\`${file}:12-34\``,
  `\`${file}:L12-L34\``,
  `[cite: \`${file}:12\`]`,
  `${file} [L97-109]`,
  `${file} [L97]`,
  `\`${file}\` L12`,
  `The rationale is at \`L1692\` in \`${file}\`.`,
  `The rationale is in \`${file}\` at \`L1692\` on the hook.`,
  `The import is in \`${file}\`; the rationale is at \`L1692\`.`,
  `The import is in \`${file}\`; the rationale is at \`L1692\` on the hook.`,
  `${file} \`:64-84\``,
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

test.each(["lower.ts", "src/client.ts"])(
  "explicit shortened citations fail unless their path exists at the repository root: %s",
  (file) => {
    expect(validateGuideCitations(`[cite: ${file} :: \`declaration\`]`, () => undefined)).toEqual([
      `${file}: missing file`,
    ]);
  },
);

test.each([
  "Edit `./src/synth.uwk.ts` and `../shared/voice.ts` in your app.",
  "Your `vite.config.ts` and `vite-env.d.ts` configure the app.",
  "Generated `worklets.d.ts` and shipped `dist/ambient.d.ts` provide types.",
  "A diagnostic points at your `check.uwk.ts` or `gain.processor.ts`.",
  '```ts\nimport value from "src/client.ts";\n```',
])(
  "consumer/generated filenames and code examples are not repository citations: %s",
  (markdown) => {
    expect(validateGuideCitations(markdown, () => undefined)).toEqual([]);
  },
);

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
  "const L1 = 1; const value = cache[L1];",
  "Use `cache[L1]` or `[L1, L2]` to select values.",
  "Use `[L1]` for a one-item array.",
  "```ts\nconst L1 = 1;\nconst value = cache[L1];\nconst items = [L1];\n```",
  "~~~ts\nconst items = [L1];\n~~~",
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

test("URL port numbers are not numeric source locations", () => {
  expect(
    validateGuideCitations("The preview is https://example.com:5173/.", () => undefined),
  ).toEqual([]);
});

test.each([`${cite}:`, `  ${cite}: \`\`\`ts`])(
  "citations cannot become Markdown reference definitions: %s",
  (markdown) => {
    expect(validateGuideCitations(markdown, read(anchor)).join("\n")).toContain(
      "Markdown reference definition",
    );
  },
);

test("source citations leave a following fenced example separate", () => {
  expect(
    validateGuideCitations(`${cite}\n\n\`\`\`ts\nconst items = [L1];\n\`\`\``, read(anchor)),
  ).toEqual([]);
});

test.each([
  `The renderer in \`${file}\` processes 12 lines per block.`,
  `\`${file}\` uses a 12-line buffer and a lineWidth of 12.`,
  "At https://example.com:5173/ the line 12 field selects an input record.",
  `\`\`\`ts\nconst diagnostic = "${file} line 12";\nconst lines = [12, 34];\n\`\`\``,
])("worded line labels need source-reference prose rather than counts or code: %s", (markdown) => {
  expect(validateGuideCitations(markdown, read(anchor))).toEqual([]);
});

test.each([
  "check.uwk.ts:12",
  "`check.uwk.ts:12`",
  "```text\ncheck.uwk.ts:12: type error\n```",
  "`classify.ts:120`",
  "[L97-109] and `L1692` and `:64-84`",
  `The loader is in \`${file}\`. Its diagnostic is \`check.uwk.ts:12\`.`,
  `The loader is in \`${file}\`. Its diagnostic is \`check.uwk.ts line 12\`.`,
  `The loader is in \`${file}\`. Its example uses \`cache[L1]\` and \`[L1]\`.`,
  `\`\`\`text\n${file}:12: example diagnostic\n\`\`\``,
])("consumer diagnostics and orphan labels are not repository evidence: %s", (markdown) => {
  expect(validateGuideCitations(markdown, read(anchor))).toEqual([]);
});

test.each(["css", "html", "svg", "json", "woff2", "custom", "7z", "my_ext"])(
  "worded locations use the whole-file reference extension rules: %s",
  (extension) => {
    const source = `packages/unplugin/devtools-ui/src/style.${extension}`;
    expect(
      validateGuideCitations(`See ${source} line 12`, (name) =>
        name === source ? "body" : undefined,
      ).join("\n"),
    ).toContain("numeric source location");
  },
);

test("a full source path in a link still checks numeric fragments", () => {
  expect(
    validateGuideCitations(
      `[source](https://github.com/yuichkun/unworklet/blob/main/${file}#L12)`,
      read(anchor),
    ).join("\n"),
  ).toContain("numeric source location");
});

test.each([
  `[source](${file}) at line 12`,
  `[source](${file}) lines 12-34`,
  `[source](${file}) (\`L12-L34\`)`,
  `[source](<${file}>) at line 12`,
  `[source](${file} "compiler source") at lines \`12-34\``,
  `**[source](${file})** at line 12`,
  `[source](${file}) at **lines 12-34**`,
  `Line 12 in [source](${file}) explains the setting.`,
  `[source][compiler] at line 12\n\n[compiler]: ${file}`,
  `[source] at lines 12-34\n\n[source]: ${file}`,
])("numeric locations remain bound to parsed source links: %s", (markdown) => {
  expect(validateGuideCitations(markdown, read(anchor)).join("\n")).toContain(
    "numeric source location",
  );
});

test.each([
  `[source](${file}) processes 12 lines per block.`,
  `[source](${file}) uses \`L1\` and \`L2\` cache.`,
  `[source](${file}) emits the consumer diagnostic \`check.uwk.ts:12\`.`,
  "[consumer](src/check.uwk.ts) at line 12",
  "[consumer][check] at line 12\n\n[check]: src/check.uwk.ts",
  `\`\`\`text\n[source](${file}) at line 12\n\`\`\``,
])(
  "link context preserves consumer prose, counts, identifiers, and fenced examples: %s",
  (markdown) => {
    expect(validateGuideCitations(markdown, read(anchor))).toEqual([]);
  },
);
