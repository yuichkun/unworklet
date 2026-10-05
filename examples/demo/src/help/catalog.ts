export { apiEntries } from "./api.ts";
export { sugarEntries, unsupportedExamples } from "./sugar.ts";
import type { HelpEntry } from "./types.ts";

export function filterEntries<T extends HelpEntry>(
  entries: T[],
  query: string,
  category: string,
): T[] {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return entries.filter((entry) => {
    const text = [
      entry.name,
      entry.summary,
      entry.category,
      ...entry.details,
      ...(entry.aliases ?? []),
    ]
      .join(" ")
      .toLocaleLowerCase();
    return (
      (category === "all" || entry.category === category) &&
      terms.every((term) => text.includes(term))
    );
  });
}
