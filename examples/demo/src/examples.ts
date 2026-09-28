// The examples as the app uses them: each entry of `example-list.ts` with its
// `.uwk.ts` source, for the editor and the in-browser compile.
import { exampleList } from "./example-list.ts";
import type { ExampleInfo } from "./example-list.ts";

export type { ExampleKind } from "./example-list.ts";

export type Example = ExampleInfo & { source: string };

const sources = import.meta.glob<string>("./examples/*.uwk.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

export const examples: Example[] = exampleList.map((info) => ({
  ...info,
  source: sources[`./examples/${info.slug}.uwk.ts`]!,
}));

export const exampleBySlug = (slug: string): Example | undefined =>
  examples.find((e) => e.slug === slug);
