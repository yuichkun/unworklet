import { marked, type Token } from "marked";

export function validateGuideCitations(
  markdown: string,
  readSource: (file: string) => string | undefined,
): string[] {
  const errors: string[] = [];
  const sources = new Map<string, string | undefined>();
  const sourceFor = (file: string): string | undefined => {
    if (
      file.includes("\\") ||
      file.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      errors.push(`${file}: expected a canonical repository-relative path`);
      return undefined;
    }
    if (!sources.has(file)) sources.set(file, readSource(file));
    const source = sources.get(file);
    if (source === undefined) errors.push(`${file}: missing file`);
    return source;
  };

  const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();
  const htmlProse = (text: string): string =>
    text.replace(
      /(\[cite:\s*[\w./-]+\.[A-Za-z0-9_-]+\s*::\s*`[^`]+`\s*\])|<!--[\s\S]*?(?:-->|$)|<(pre|code|script|style|template)\b[^>]*>[\s\S]*?(?:<\/\2\s*>|$)/gi,
      (match, citation: string | undefined) => (citation ? match : ""),
    );
  const tokens = marked.lexer(markdown);
  const inlineMarkdown = (tokens: Token[]): string => {
    let text = "";
    let htmlCodeTag: string | undefined;
    for (const token of tokens) {
      if (htmlCodeTag) {
        if (token.type === "html" && new RegExp(`^</${htmlCodeTag}\\s*>$`, "i").test(token.raw)) {
          htmlCodeTag = undefined;
        }
        continue;
      }
      if (token.type === "code") continue;
      if (token.type === "html") {
        htmlCodeTag = /^<(pre|code|script|style|template)\b[^>]*>$/i.exec(token.raw)?.[1];
        text += htmlProse(token.raw);
        continue;
      }
      if (
        token.type === "codespan" &&
        token.text.includes("[cite:") &&
        !/\[cite:\s*[\w./-]+\.[A-Za-z0-9_-]+\s*::\s*$/.test(text)
      )
        continue;
      if (token.type === "link") {
        text += `[${inlineMarkdown(token.tokens!)}](<${token.href}>)`;
      } else if ("tokens" in token && token.tokens) {
        text += inlineMarkdown(token.tokens);
      } else {
        text += token.raw;
      }
    }
    return text;
  };
  const prose: string[] = [];
  void marked.walkTokens(tokens, (token) => {
    if (token.type === "html") prose.push(htmlProse(token.raw));
    if (["paragraph", "heading", "text"].includes(token.type) && "tokens" in token && token.tokens)
      prose.push(inlineMarkdown(token.tokens));
    if (token.type === "table") {
      for (const cell of [...token.header, ...token.rows.flat()]) {
        prose.push(inlineMarkdown(cell.tokens));
      }
    }
  });
  if (Object.keys(tokens.links).some((label) => label.startsWith("cite:"))) {
    errors.push(
      "citation must not become a Markdown reference definition; omit its trailing colon",
    );
  }
  markdown = prose.join("\n\n");
  let locations = markdown;
  let citationEnd = 0;
  for (const start of markdown.matchAll(/\[cite:/g)) {
    if (start.index < citationEnd) continue;
    const citation = /^\[cite:\s*([\w./-]+\.[A-Za-z0-9_-]+)\s*::\s*`([^`]+)`\s*\]/.exec(
      markdown.slice(start.index),
    );
    if (!citation || citation[1]!.split("/").includes("..") || !normalize(citation[2]!)) {
      errors.push(
        `malformed citation at offset ${start.index}; expected [cite: path :: \`unique source excerpt\`]`,
      );
      continue;
    }
    citationEnd = start.index + citation[0].length;
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
    /\b(?:packages|examples|scripts)[/\\][\w./\\-]*\.[A-Za-z0-9_-]+(?:[/\\][\w./\\-]*)*|(?<![\w.-])README\.md(?![\w-]|\.[\w])(?:[/\\][\w./\\-]*)*/g;
  const afterPath =
    /^`?(?:#L?\d+(?:C\d+)?(?:[-–]L?\d+(?:C\d+)?)?(?=$|[\s`)\]<>"',;]|[.!?:]+(?:\s|$))|:\s*L?\d+|\s*[,;:.]?\s*[([]?\s*(?:(?:at|see|on|in)\s+)?[([]?\s*`?(?:L|lines?\s+`?#?L?|:)`?\d+)/i;
  const beforePath =
    /(?:\bL\d+(?:C\d+)?(?:\s*[-–]\s*L?\d+(?:C\d+)?)?|\blines?\s+#?L?\d+(?:C\d+)?(?:(?:\s*[-–]\s*|\s+to\s+)#?L?\d+(?:C\d+)?)?)\s+(?:in|of|from|at)\s+$/i;
  const isRepositoryUrlPrefix = (prefix: string): boolean => {
    const candidate = prefix.replace(/^[<([]/, "");
    if (!/^https?:\/\//i.test(candidate)) return false;
    try {
      const url = new URL(candidate);
      if (url.username || url.password || url.search || url.hash) return false;
      return (
        (url.host === "github.com" &&
          /^\/yuichkun\/unworklet\/(?:blob|raw)\/.+\/$/i.test(url.pathname)) ||
        (url.host === "raw.githubusercontent.com" &&
          /^\/yuichkun\/unworklet\/.+\/$/i.test(url.pathname))
      );
    } catch {
      return false;
    }
  };
  const inspectProse = (text: string): void => {
    const references = [...text.matchAll(repositoryFile)];
    for (const reference of references) {
      const file = reference[0];
      const prefix = /[^\s`]*[/\\]$/.exec(text.slice(0, reference.index))?.[0];
      if (prefix && !isRepositoryUrlPrefix(prefix)) {
        errors.push(`${prefix + file}: expected a canonical repository-relative path`);
        continue;
      }
      sourceFor(file);
      const suffix = text.slice(reference.index + file.length).replace(/^\?[^#\s`]*(?=#)/, "");
      const after = afterPath.exec(suffix);
      const before = beforePath.exec(text.slice(0, reference.index).replaceAll("`", ""));
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
        /\bat\s+`L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?`(?=\s*(?:[.,;)]|(?:on|in)\b|$))/g,
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
    if (token.type === "html") inspectProse(token.raw);
    // Inline code is how the guide spells paths, but fenced examples/output
    // are not source-reference prose. Links carry evidence in their destination.
    if (
      ["paragraph", "text", "heading", "codespan", "link"].includes(token.type) &&
      "text" in token
    ) {
      if ("tokens" in token && token.tokens) inspectProse(linkDestinations(token.tokens));
      else inspectProse(token.text);
    }
    if (token.type === "link") {
      inspectProse(token.href);
      if (token.tokens && token.href.match(repositoryFile)) {
        const label = normalize(linkDestinations(token.tokens).replaceAll("`", ""));
        const withoutCacheTerms = label.replace(
          /\bL\d+(?:\s*(?:\/|and|,)\s*L\d+)*(?:\s+(?:data|instruction|unified))?\s+caches?\b/gi,
          "cache",
        );
        const location =
          /(?:^|[\s(]):\s*L?\d+(?:C\d+)?(?:\s*[-–]\s*L?\d+(?:C\d+)?)?\b|\bat\s+L\d+(?:C\d+)?(?:\s*[-–]\s*L?\d+(?:C\d+)?)?\b|\blines?\s+#?L?\d+(?:C\d+)?(?:\s*[-–]\s*L?\d+(?:C\d+)?|\s+to\s+L?\d+(?:C\d+)?)?\b/i.exec(
            label,
          ) ?? /(?:^|[\s(])L\d+(?:C\d+)?(?:\s*[-–]\s*L?\d+(?:C\d+)?)?\b/i.exec(withoutCacheTerms);
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
