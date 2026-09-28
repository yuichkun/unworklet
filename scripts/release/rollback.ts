/**
 * Withdraws a bad release, run by a maintainer from their own machine: npm only
 * lets a person with 2FA move `latest` or deprecate a version, so the release
 * workflow cannot. After npm, it asks the Rollback workflow to put the demo of
 * the restored version back on the production domain, keeping the two in line.
 * The usual response to a bad release is a fixed one through the release
 * workflow; this is for when that cannot wait.
 *
 *   vp exec node scripts/release/rollback.ts <version to restore> <version to withdraw> "<reason>"
 */

import { execFileSync } from "node:child_process";

const PACKAGES = [
  "@unworklet/core",
  "@unworklet/lang",
  "@unworklet/offline",
  "@unworklet/test",
  "@unworklet/unplugin",
];

export function rollbackCommands(options: {
  packages: string[];
  restore: string;
  withdraw: string;
  reason: string;
}): string[][] {
  const message = `Withdrawn; use ${options.restore} until a fixed release. ${options.reason}`;
  return [
    ...options.packages.map((p) => [
      "vp",
      "pm",
      "dist-tag",
      "add",
      `${p}@${options.restore}`,
      "latest",
    ]),
    ...options.packages.map((p) => ["vp", "pm", "deprecate", `${p}@${options.withdraw}`, message]),
    [
      "gh",
      "workflow",
      "run",
      "rollback.yml",
      "--repo",
      "yuichkun/unworklet",
      "-f",
      `version=${options.restore}`,
    ],
  ];
}

function main(): void {
  const [restore, withdraw, reason] = process.argv.slice(2);
  if (!restore || !withdraw || !reason) {
    console.error(
      'Usage: vp exec node scripts/release/rollback.ts <version to restore> <version to withdraw> "<reason>"',
    );
    process.exit(1);
  }
  for (const [command, ...args] of rollbackCommands({
    packages: PACKAGES,
    restore,
    withdraw,
    reason,
  })) {
    console.log(`$ ${command} ${args.join(" ")}`);
    execFileSync(command!, args, { stdio: "inherit" });
  }
}

if (import.meta.main) main();
