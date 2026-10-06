import { marked } from "marked";

export function validateGuideCitations(
  markdown: string,
  readSource: (file: string) => string | undefined,
): string[] {
  const errors: string[] = [];
  const sources = new Map<string, string | undefined>();
  const sourceFor = (file: string): string | undefined => {
    if (!sources.has(file)) sources.set(file, readSource(file));
    const source = sources.get(file);
    if (source === undefined) errors.push(`${file}: missing file`);
    return source;
  };

  const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();
  let locations = markdown;
  for (const start of markdown.matchAll(/\[cite:/g)) {
    const citation = /^\[cite:\s*([\w./-]+\.[A-Za-z]+)\s*::\s*`([^`]+)`\s*\]/.exec(
      markdown.slice(start.index),
    );
    if (!citation || citation[1]!.split("/").includes("..") || !normalize(citation[2]!)) {
      errors.push(
        `malformed citation at offset ${start.index}; expected [cite: path :: \`unique source excerpt\`]`,
      );
      continue;
    }
    const lineStart = markdown.lastIndexOf("\n", start.index) + 1;
    if (
      /^ {0,3}$/.test(markdown.slice(lineStart, start.index)) &&
      markdown[start.index + citation[0].length] === ":"
    ) {
      errors.push(
        "citation must not become a Markdown reference definition; omit its trailing colon",
      );
    }
    // The excerpt is source text, so identifiers such as L1 are not locations.
    locations = locations.replace(citation[0], "");
    const [, file, excerpt] = citation;
    const source = sourceFor(file!);
    if (source === undefined) continue;
    const anchor = normalize(excerpt!);
    const matches = normalize(source).split(anchor).length - 1;
    if (matches === 0) errors.push(`${file}: anchor not found: ${anchor}`);
    else if (matches > 1)
      errors.push(`${file}: anchor is ambiguous (${matches} matches): ${anchor}`);
  }

  // Require citation syntax, rather than rejecting ordinary L1/L2 cache prose.
  // Whole-file references, inline path:line, links and bracketed shorthand all
  // occur outside [cite:] blocks in the guide, so scan beyond those blocks.
  const numeric =
    /[\w./-]+\.[A-Za-z]+(?:`?(?:\s+\(?|\s*\()`?L\d+(?:-L?\d+)?|:L?\d+(?:-L?\d+)?|#L\d+(?:-L?\d+)?)|`:\d+(?:-\d+)?`/g;
  const reportLocation = (location: string): void => {
    errors.push(`numeric source location: ${location}; use a content-anchored [cite:]`);
  };
  // Strip URL authorities (including ports), retaining their source paths and
  // fragments so GitHub path#L links are still checked.
  const paths = locations.replace(/\b[a-z][a-z\d+.-]*:\/\/[^/\s)]+/gi, "");
  for (const [location] of paths.matchAll(numeric)) reportLocation(location);
  void marked.walkTokens(marked.lexer(paths), (token) => {
    // Code spans/blocks can contain array literals and indexed identifiers.
    // Only leaf prose text can use bracketed shorthand as a citation.
    if (token.type === "text" && !("tokens" in token && token.tokens)) {
      for (const [location] of token.text.matchAll(/(?<![\w$.\]])\[L\d+(?:-L?\d+)?\]/g)) {
        reportLocation(location);
      }
    }
    if (!["paragraph", "text", "heading"].includes(token.type) || !("text" in token)) return;
    const paragraph = token.text;
    if (!/\b(?:[\w./-]+\.(?:[cm]?[jt]sx?|vue|json|md|ya?ml|sh))\b/.test(paragraph)) return;
    // Worded labels may precede or follow the path, with punctuation or code
    // spans between them. Counts such as "12 lines" are not source labels.
    for (const [location] of paragraph.matchAll(/\blines?\s+`?L?\d+(?:[-–]L?\d+)?/gi)) {
      reportLocation(location);
    }
    // A phrase such as "at `L1692` on the hook" refers back to the file in
    // this paragraph. A code-span identifier on its own supplies no location.
    for (const [, location] of paragraph.matchAll(
      /\b(?:at|lines?)\s+`(L\d+(?:-L?\d+)?)`(?=\s*(?:[.,;)]|(?:on|in)\b|$))/g,
    )) {
      reportLocation(location!);
    }
  });

  // Whole-file references need no content selector, but must still exist.
  for (const [file] of markdown.matchAll(
    /\b(?:packages|examples|scripts)\/[\w./-]*\.[A-Za-z]+|(?<![\w/])README\.md\b/g,
  )) {
    sourceFor(file);
  }
  return [...new Set(errors)];
}
