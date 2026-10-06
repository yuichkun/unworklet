import { marked, type Token } from "marked";

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
    const citation = /^\[cite:\s*([\w./-]+\.[A-Za-z0-9_-]+)\s*::\s*`([^`]+)`\s*\]/.exec(
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

  // The same path grammar establishes both file existence and numeric-location
  // intent. Bare application filenames and orphan line labels are not evidence.
  const repositoryFile =
    /\b(?:packages|examples|scripts)\/[\w./-]*\.[A-Za-z0-9_-]+|(?<![\w/])README\.md\b/g;
  const afterPath =
    /^`?(?:[#:]\s*L?\d+|\s*[,;:.]?\s*(?:(?:at|see)\s+)?[([]?\s*`?(?:L|lines?\s+|:)`?\d+)/i;
  const beforePath =
    /(?:\bL\d+(?:[-–]L?\d+)?|\blines?\s+`?L?\d+(?:(?:[-–]|\s+to\s+)L?\d+)?`?)`?\s+(?:in|of|from|at)\s+`?$/i;
  const inspectProse = (text: string): void => {
    const references = [...text.matchAll(repositoryFile)];
    for (const reference of references) {
      const file = reference[0];
      sourceFor(file);
      const after = afterPath.exec(text.slice(reference.index + file.length));
      const before = beforePath.exec(text.slice(0, reference.index));
      const location = after?.[0] ?? before?.[0];
      if (location) {
        errors.push(
          `numeric source location: ${file} ${location.trim()}; use a content-anchored [cite:]`,
        );
      }
    }
    // An explicit "at `L...`" phrase can refer back across a clause. It still
    // needs a repository path in this prose region; consumer filenames do not
    // establish that context.
    if (references.length > 0) {
      for (const [location] of text.matchAll(
        /\bat\s+`L\d+(?:-L?\d+)?`(?=\s*(?:[.,;)]|(?:on|in)\b|$))/g,
      )) {
        errors.push(`numeric source location: ${location}; use a content-anchored [cite:]`);
      }
    }
  };
  const linkDestinations = (tokens: Token[]): string =>
    tokens
      .map((token) => {
        if (token.type === "link") return token.href.replace(/[?#].*$/, "");
        if ("tokens" in token && token.tokens) return linkDestinations(token.tokens);
        return token.raw;
      })
      .join("");
  void marked.walkTokens(marked.lexer(locations), (token) => {
    // Inline code is how the guide spells paths, but fenced examples/output
    // are not source-reference prose. Links carry evidence in their destination.
    if (
      ["paragraph", "text", "heading", "codespan", "link"].includes(token.type) &&
      "text" in token
    ) {
      inspectProse(token.text);
      if ("tokens" in token && token.tokens) inspectProse(linkDestinations(token.tokens));
    }
    if (token.type === "link") {
      inspectProse(token.href);
      if (token.tokens && token.href.match(repositoryFile)) {
        const label = normalize(linkDestinations(token.tokens).replaceAll("`", ""));
        const location =
          /\blines?\s+L?\d+(?:\s*[-–]\s*L?\d+|\s+to\s+L?\d+)?\b|^L\d+(?:\s*[-–]\s*L?\d+)?$/i.exec(
            label,
          );
        if (location)
          errors.push(
            `numeric source location: ${token.href} ${location[0]}; use a content-anchored [cite:]`,
          );
      }
    }
    if (token.type === "table") {
      for (const cell of [...token.header, ...token.rows.flat()]) {
        inspectProse(cell.text);
        inspectProse(linkDestinations(cell.tokens));
      }
    }
  });

  return [...new Set(errors)];
}
