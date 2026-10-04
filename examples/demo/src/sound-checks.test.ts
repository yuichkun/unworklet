import { readdirSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import { examples } from "./examples.ts";
import { soundChecks } from "./sound-checks.ts";

test("every demo has exactly one golden sound check using its original source", () => {
  const demos = soundChecks.filter((check) => check.group === "example");
  expect(demos.map((check) => check.slug).sort()).toEqual(
    examples.map((example) => example.slug).sort(),
  );
  for (const demo of demos) {
    expect(demo.source).toBe(examples.find((example) => example.slug === demo.slug)!.source);
  }
});

test("sound check slugs are unique and correspond exactly to committed WAVs", () => {
  const slugs = soundChecks.map((check) => check.slug);
  expect(new Set(slugs).size).toBe(slugs.length);
  expect(
    readdirSync(new URL("./__goldens__", import.meta.url))
      .filter((name) => name.endsWith(".wav"))
      .sort(),
  ).toEqual(slugs.map((slug) => `${slug}.wav`).sort());
});
