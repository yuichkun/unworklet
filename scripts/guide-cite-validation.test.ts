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

const proseContainers: [string, (content: string) => string][] = [
  ["paragraph", (content) => content],
  ["heading", (content) => `## ${content}`],
  ["list", (content) => `- ${content}`],
  ["nested list", (content) => `- Evidence\n  - ${content}`],
  ["blockquote", (content) => `> ${content}`],
  ["table header", (content) => `| ${content} |\n| --- |\n| setting |`],
  ["table body", (content) => `| Evidence |\n| --- |\n| ${content} |`],
];
test.each(
  proseContainers.flatMap(([name, render]) =>
    [
      `[source](${file}?plain=1#L12)`,
      `[source](https://github.com/yuichkun/unworklet/blob/main/${file}?plain=1#L12-L34)`,
      `[source][compiler]`,
      `[compiler (L12-L34)](${file})`,
      `[compiler at L12](${file})`,
      `[(L12)](${file})`,
      `[compiler **(L12–L34)**](${file}?plain=1#definition)`,
    ].map((content) => [name, `${render(content)}\n\n[compiler]: ${file}?plain=1#L12-L34`]),
  ),
)("source links retain numeric fragments and contextual labels in %s", (_, markdown) => {
  expect(validateGuideCitations(markdown, read(anchor)).join("\n")).toContain(
    "numeric source location",
  );
});

test.each([
  `[source](${file}?plain=1#definition)`,
  `[L1 cache](${file}?plain=1#definition)`,
  `[compiler cache[L1]](${file})`,
  `[source](${file}?example=L12#definition)`,
  "[compiler (L12-L34)](src/check.uwk.ts?plain=1#L12)",
  "[source](https://example.com/manual?plain=1#L12)",
  `\`\`\`text\n[source](${file}?plain=1#L12)\n\`\`\``,
])("non-location fragments and non-source links remain valid: %s", (markdown) => {
  expect(validateGuideCitations(markdown, read(anchor))).toEqual([]);
});

test.each([
  `[line 12](${file})`,
  `[lines 12-34](${file})`,
  `[L12-L34](${file})`,
  `[\`L12\`](${file})`,
  `[**lines 12-34**](${file})`,
  `[lines \`12-34\`][compiler]\n\n[compiler]: ${file}`,
  `[compiler at line 12](${file})`,
  `[line 12](${file}#definition)`,
  `[lines 12-34](${file}?plain=1#definition)`,
  `[L12](${file}?plain=1)`,
])("explicit line labels are bound to their parsed source destination: %s", (markdown) => {
  expect(validateGuideCitations(markdown, read(anchor)).join("\n")).toContain(
    "numeric source location",
  );
});

test.each([
  `[compiler source](${file})`,
  `[compiler definition](${file}#definition)`,
  `[compiler source](${file}?plain=1#definition)`,
  `[issue 12](${file})`,
  `[#12](${file})`,
  `[12](${file})`,
  `[12 lines per block](${file})`,
  `[L1 cache](${file})`,
  "[line 12](src/check.uwk.ts)",
  "[lines 12-34][app]\n\n[app]: src/check.uwk.ts",
])("descriptive, numeric, and consumer link labels are not source locations: %s", (markdown) => {
  expect(validateGuideCitations(markdown, read(anchor))).toEqual([]);
});

test.each(
  proseContainers.flatMap(([name, render]) =>
    [
      `[source](${file}) at line 12`,
      "**[source][compiler]** at lines `12-34`",
      `\`${file}\` at line 12`,
    ].map((content) => [name, `${render(content)}\n\n[compiler]: ${file}`]),
  ),
)("numeric source evidence is checked within each Markdown prose container: %s", (_, markdown) => {
  expect(validateGuideCitations(markdown, read(anchor)).join("\n")).toContain(
    "numeric source location",
  );
});

test.each([
  `| Source | Diagnostic |\n| --- | --- |\n| [source](${file}) | \`check.uwk.ts:12\` |`,
  `| Source | Label |\n| --- | --- |\n| [source](${file}) | at \`L12\` |`,
  `| Evidence |\n| --- |\n| [source](${file}) processes 12 lines per block |`,
  "| Consumer |\n| --- |\n| [app](src/check.uwk.ts) at line 12 |",
  `\`\`\`text\n| Evidence |\n| --- |\n| [source](${file}) at line 12 |\n\`\`\``,
])("table cells retain consumer and code controls without cross-cell inference: %s", (markdown) => {
  expect(validateGuideCitations(markdown, read(anchor))).toEqual([]);
});

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
  `[source](${file}#definition) at line 12`,
  `[source](${file}?plain=1#definition) at lines 12-34`,
  `[source](${file}?plain=1) (\`L12-L34\`)`,
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

test.each(
  proseContainers.flatMap(([name, render]) =>
    [
      `${file}?plain=1#L12`,
      `\`${file}?plain=1#L12-L34\``,
      `\`https://github.com/yuichkun/unworklet/blob/main/${file}?plain=1#128\``,
    ].map((content) => [name, render(content)]),
  ),
)("query-bearing numeric references are rejected in every prose form: %s", (_, markdown) => {
  expect(validateGuideCitations(markdown, read(anchor)).join("\n")).toContain(
    "numeric source location",
  );
});

test.each(
  ["L1-cache-behavior", "128-sample-blocks", "L12-L34-examples", "128.samples"].flatMap(
    (fragment) => [
      `[source](${file}#${fragment})`,
      `[source](${file}?plain=1#${fragment})`,
      `\`${file}?plain=1#${fragment}\``,
      `See ${file}#${fragment}`,
    ],
  ),
)("complete semantic fragments remain valid: %s", (markdown) => {
  expect(validateGuideCitations(markdown, read(anchor))).toEqual([]);
});

test.each(
  ["view[mode]=raw", "view=(raw)", "view='raw'", 'view="raw"'].flatMap((query) =>
    proseContainers.map(([name, render]) => [name, render(`\`${file}?${query}#L12-L34\``)]),
  ),
)("query punctuation cannot hide numeric fragments in %s", (_, markdown) => {
  expect(validateGuideCitations(markdown, read(anchor)).join("\n")).toContain(
    "numeric source location",
  );
});

test.each([
  `\`${file}?view[mode]=(raw)#L1-cache-behavior\``,
  `\`${file}?view=(raw)\` is an example. The identifier is #L12.`,
  `${file}?view=raw is an example. The identifier is #L12.`,
])("query normalization stays inside its source reference: %s", (markdown) => {
  expect(validateGuideCitations(markdown, read(anchor))).toEqual([]);
});

test.each([
  `\`\`\`text\n${file}?plain=1#L12\n\`\`\``,
  "`src/check.uwk.ts?plain=1#L12`",
  `\`${file}?example=L12\``,
])("query inspection retains code and consumer controls: %s", (markdown) => {
  expect(validateGuideCitations(markdown, read(anchor))).toEqual([]);
});

test.each([".", "!", "?", ":"])(
  "numeric fragments remain locations before sentence punctuation %s",
  (punctuation) => {
    for (const fragment of ["L12", "L12-L34", "128"]) {
      expect(
        validateGuideCitations(`See ${file}?plain=1#${fragment}${punctuation}`, read(anchor)).join(
          "\n",
        ),
      ).toContain("numeric source location");
    }
  },
);

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
