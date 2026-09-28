// The examples as the app uses them: each entry of `example-list.ts` with its
// `.uwk.ts` source, for the editor and the in-browser compile, and its build-time
// compile through the Vite plugin (`?worklet`), which is how most applications
// load a processor.
import type { CompiledProcessor } from "@unworklet/core";

import { exampleList } from "./example-list.ts";
import type { ExampleInfo } from "./example-list.ts";

export type { ExampleKind } from "./example-list.ts";

export type Example = ExampleInfo & {
  source: string;
  /** The processor compiled at build time by `@unworklet/unplugin`. */
  worklet: () => Promise<CompiledProcessor<unknown>>;
};

const sources = import.meta.glob<string>("./examples/*.uwk.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});
const worklets = import.meta.glob<CompiledProcessor<unknown>>("./examples/*.uwk.ts", {
  query: "?worklet",
  import: "default",
});

export const examples: Example[] = exampleList.map((info) => ({
  ...info,
  source: sources[`./examples/${info.slug}.uwk.ts`]!,
  worklet: worklets[`./examples/${info.slug}.uwk.ts`]!,
}));

export const exampleBySlug = (slug: string): Example | undefined =>
  examples.find((e) => e.slug === slug);
