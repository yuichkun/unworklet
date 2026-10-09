import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { instrumentWorklet, instrumentClient, instrumentTest } from "./instrument.mjs";

for (const ref of [
  "0c4c889f4898197009cfc8879a1aedd1509246e2",
  "febd2a1684d92fc4a9fb86e55e9b6a1af989ec9e",
  "8b7abf7f109a99b347ec7a0e53f8cb9d1f7f9faa",
]) {
  /** @type {Array<[string, (source: string, enabled?: boolean) => string]>} */
  const transforms = [
    ["src/worklet.ts", instrumentWorklet],
    ["src/client.ts", instrumentClient],
    [
      "src/__tests__/browser/postmessage/message-counter.test.ts",
      (source) => instrumentTest(source),
    ],
  ];
  for (const [file, transform] of transforms) {
    const source = execFileSync("git", ["show", `${ref}:packages/core/${file}`], {
      encoding: "utf8",
    });
    for (const enabled of [false, true]) {
      const output = transform(source, enabled);
      if (file.includes("message-counter")) {
        for (const invariant of [
          "expect(observed).toBe(42)",
          "await waitRAF(2)",
          "buildContext(32)",
          "sender({ value: 42 })",
        ]) {
          assert.equal(output.split(invariant).length, source.split(invariant).length);
        }
      }
    }
  }
  console.log(ref, "all anchors unique; original scenario invariants preserved");
}
