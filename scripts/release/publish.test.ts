import { expect, test } from "vite-plus/test";

import { publishRelease } from "./publish.ts";
import type { Registry } from "./publish.ts";
import type { Tarball } from "./tarballs.ts";

const TARBALLS: Tarball[] = [
  {
    name: "@unworklet/core",
    version: "0.4.0",
    file: "core.tgz",
    integrity: "sha512-core",
    dependsOn: [],
  },
  {
    name: "@unworklet/lang",
    version: "0.4.0",
    file: "lang.tgz",
    integrity: "sha512-lang",
    dependsOn: ["@unworklet/core"],
  },
  {
    name: "@unworklet/offline",
    version: "0.4.0",
    file: "offline.tgz",
    integrity: "sha512-offline",
    dependsOn: ["@unworklet/core"],
  },
  {
    name: "@unworklet/test",
    version: "0.4.0",
    file: "test.tgz",
    integrity: "sha512-test",
    dependsOn: ["@unworklet/offline"],
  },
  {
    name: "@unworklet/unplugin",
    version: "0.4.0",
    file: "unplugin.tgz",
    integrity: "sha512-unplugin",
    dependsOn: ["@unworklet/lang"],
  },
];

/**
 * A registry where a published version becomes visible only after a scan
 * delay, like npm's publish-time malware scan. `events` records every publish
 * and every moment a version became visible, in order.
 */
function fakeRegistry(
  options: {
    scanMs?: number;
    present?: Record<string, string>;
    serve?: (t: Tarball) => string;
  } = {},
) {
  let now = 0;
  const events: string[] = [];
  const visible = new Map<string, string>(Object.entries(options.present ?? {}));
  const pending: Array<{ name: string; integrity: string; at: number }> = [];

  const settle = () => {
    for (const p of pending.splice(0)) {
      if (p.at <= now) {
        visible.set(p.name, p.integrity);
        events.push(`visible ${p.name}`);
      } else {
        pending.push(p);
      }
    }
  };

  const registry: Registry = {
    async integrity(name) {
      settle();
      return visible.get(name) ?? null;
    },
  };
  return {
    registry,
    events,
    publish: async (t: Tarball) => {
      events.push(`publish ${t.name}`);
      pending.push({
        name: t.name,
        integrity: options.serve?.(t) ?? t.integrity,
        at: now + (options.scanMs ?? 0),
      });
    },
    sleep: async (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

test("each layer is published only after the previous layer can be installed", async () => {
  const fake = fakeRegistry({ scanMs: 300_000 });

  const result = await publishRelease(TARBALLS, { ...fake, pollMs: 10_000, timeoutMs: 3_600_000 });

  expect(fake.events).toEqual([
    "publish @unworklet/core",
    "visible @unworklet/core",
    "publish @unworklet/lang",
    "publish @unworklet/offline",
    "visible @unworklet/lang",
    "visible @unworklet/offline",
    "publish @unworklet/test",
    "publish @unworklet/unplugin",
    "visible @unworklet/test",
    "visible @unworklet/unplugin",
  ]);
  expect(result).toEqual(TARBALLS.map((t) => ({ name: t.name, action: "published" })));
});

test("a rerun skips the packages npm already has with the same integrity", async () => {
  const fake = fakeRegistry({
    present: { "@unworklet/core": "sha512-core", "@unworklet/lang": "sha512-lang" },
  });

  const result = await publishRelease(TARBALLS, { ...fake, pollMs: 10_000, timeoutMs: 60_000 });

  expect(fake.events.filter((e) => e.startsWith("publish"))).toEqual([
    "publish @unworklet/offline",
    "publish @unworklet/test",
    "publish @unworklet/unplugin",
  ]);
  expect(result.slice(0, 2)).toEqual([
    { name: "@unworklet/core", action: "already-published" },
    { name: "@unworklet/lang", action: "already-published" },
  ]);
});

test("a version npm already has with different contents stops the release before anything is published", async () => {
  const fake = fakeRegistry({ present: { "@unworklet/test": "sha512-something-else" } });

  await expect(
    publishRelease(TARBALLS, { ...fake, pollMs: 10_000, timeoutMs: 60_000 }),
  ).rejects.toThrow(/@unworklet\/test@0\.4\.0.*sha512-something-else.*sha512-test/s);
  expect(fake.events).toEqual([]);
});

test("npm serving different contents than were published stops the release at once", async () => {
  const fake = fakeRegistry({ serve: () => "sha512-tampered" });

  await expect(
    publishRelease(TARBALLS, { ...fake, pollMs: 10_000, timeoutMs: 3_600_000 }),
  ).rejects.toThrow(/@unworklet\/core@0\.4\.0.*sha512-tampered.*sha512-core/s);
  expect(fake.events).toEqual(["publish @unworklet/core", "visible @unworklet/core"]);
});

test("a package that never becomes installable stops the release before the next layer", async () => {
  const fake = fakeRegistry({ scanMs: Number.POSITIVE_INFINITY });

  await expect(
    publishRelease(TARBALLS, { ...fake, pollMs: 60_000, timeoutMs: 1_800_000 }),
  ).rejects.toThrow(/@unworklet\/core@0\.4\.0.*30 minutes/s);
  expect(fake.events).toEqual(["publish @unworklet/core"]);
});
