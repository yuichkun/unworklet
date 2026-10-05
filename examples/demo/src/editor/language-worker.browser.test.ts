import { expect, test } from "vite-plus/test";
import { EditorWorkerClient } from "./worker-client.ts";
import { examples } from "../examples.ts";

test("browser worker loads bundled snapshot and supports sugar hover, completion, signature and errors", async () => {
  const errors: string[] = [];
  const start = performance.now();
  const client = new EditorWorkerClient(
    new Worker(new URL("./language.worker.ts", import.meta.url), { type: "module" }),
    (message) => errors.push(message),
  );
  const largest = [...examples].sort((a, b) => b.source.length - a.source.length)[0]!;
  let version = 1;
  const uri = "file:///playground/browser.uwk.ts";
  try {
    client.update({ uri, version, source: largest.source });
    const diagnostics = await client.query("diagnostics", 0);
    expect(errors).toEqual([]);
    expect(diagnostics?.diagnostics).toEqual([]);
    const cold = performance.now() - start;
    const source =
      'const input = audioInput({ channels: 2 }); const gain = param.f32({ default: 1, min: 0, max: 2, automationRate: "a-rate" }); process(() => { forSample((i) => { const l = input.left[i] * gain[i]; }); });';
    client.update({ uri, version: ++version, source });
    const info = await client.query("hover", source.indexOf("const l") + 6);
    expect(info?.hover?.text).toContain('Node<"f32">');
    client.update({ uri, version: ++version, source: "state." });
    expect(
      (await client.query("completion", 6))?.completions?.some((item) => item.name === "buffer"),
    ).toBe(true);
    const unfinished = "out.left[i] = clamp(f32(0), f32(0), ";
    client.update({ uri, version: ++version, source: unfinished });
    const signature = (await client.query("signature", unfinished.length))?.signature;
    expect(signature?.items[0]?.label).toContain("clamp(");
    expect(signature?.activeParameter).toBe(2);
    client.update({ uri, version: ++version, source: "process(() => { unknownName(); });" });
    const invalid = await client.query("diagnostics", 0);
    expect(
      invalid?.diagnostics?.some((d) => d.message.includes("unknownName") && d.start === 16),
    ).toBe(true);
    client.update({ uri, version: ++version, source: largest.source });
    await client.query("hover", largest.source.indexOf("const") + 6);
    const warmStart = performance.now();
    await client.query("hover", largest.source.indexOf("const") + 6);
    console.info(
      `editor benchmark: ${largest.slug} ${largest.source.length} chars, cold ${cold.toFixed(2)}ms, warm hover ${(performance.now() - warmStart).toFixed(2)}ms`,
    );
  } finally {
    client.dispose();
  }
}, 60_000);
