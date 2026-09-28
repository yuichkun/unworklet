// Renders every example in its sound scenario and writes each output channel
// as raw Float32 samples, with an index.json naming the files. A release runs
// this once against the published version and once against the candidate, and
// compares the two directories. An example that fails to build is recorded with
// its error, since an older version may not support what a newer example uses.
// The packages are imported as namespaces for the same reason: a function the
// published version lacks fails each example rather than the whole render.
//
//   node src/render-examples.ts <out dir>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as lang from "@unworklet/lang/browser";
import * as offline from "@unworklet/offline";

import { exampleList } from "./example-list.ts";
import { DURATION, SAMPLE_RATE, soundScenario } from "./sound-scenarios.ts";

export type RenderIndexEntry = {
  slug: string;
  title: string;
  outputs?: Record<string, string[]>;
  error?: string;
};

export async function renderExamples(out: string): Promise<RenderIndexEntry[]> {
  mkdirSync(out, { recursive: true });
  const index: RenderIndexEntry[] = [];
  for (const example of exampleList) {
    try {
      const source = readFileSync(
        new URL(`./examples/${example.slug}.uwk.ts`, import.meta.url),
        "utf8",
      );
      const result = await offline.renderOffline(lang.lowerToProcessor(source), {
        sampleRate: SAMPLE_RATE,
        duration: DURATION,
        ...soundScenario(example),
      });
      const outputs = Object.fromEntries(
        Object.entries(result.outputs).map(([name, channels]) => [
          name,
          channels.map((data, channel) => {
            const file = `${example.slug}.${name}.${channel}.f32`;
            writeFileSync(
              path.join(out, file),
              new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
            );
            return file;
          }),
        ]),
      );
      index.push({ slug: example.slug, title: example.title, outputs });
    } catch (error) {
      index.push({
        slug: example.slug,
        title: example.title,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  writeFileSync(path.join(out, "index.json"), JSON.stringify(index, null, 2) + "\n");
  return index;
}

if (import.meta.main) await renderExamples(path.resolve(process.argv[2] ?? "renders"));
